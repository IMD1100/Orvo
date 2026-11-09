import argparse
from collections import Counter
from datetime import datetime
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import types
import uuid

import numpy as np
from scipy import signal
import soundfile as sf

from tool_catalog import CATALOG, DEFAULTS, NAMES, RANGES, ROOT, VENDOR, default_effect, normalize_plan, validate_plan
from quality import analyze_audio, dump, validate_targets
from audio_inputs import open_audio
from audio_routing import INPUT, OUTPUT, validate_routing

_DSP = None


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_dsp():
    global _DSP
    if _DSP is None:
        # Skip the upstream package initializer; only the original rendering module is needed.
        package = types.ModuleType("llm2fx_original_ndsp")
        package.__path__ = [str(VENDOR)]
        sys.modules[package.__name__] = package
        _module("llm2fx_original_ndsp.constants", VENDOR / "constants.py")
        _DSP = _module("llm2fx_original_ndsp.pb_functional", VENDOR / "pb_functional.py")
    return _DSP


def read_audio(path):
    with open_audio(path) as handle:
        sr = handle.samplerate
        audio = handle.read(dtype="float32", always_2d=True)
    if len(audio) < 64 or audio.shape[1] not in (1, 2) or not np.isfinite(audio).all():
        raise ValueError("请选择有效的单声道或双声道音频。")
    if sr != 44100:
        divisor = math.gcd(sr, 44100)
        audio = signal.resample_poly(audio, 44100 // divisor, sr // divisor, axis=0).astype(np.float32)
    return audio, 44100


def audio_features(path):
    """Whole-audio statistics; bounded blocks preserve global Welch window alignment."""
    with open_audio(path) as handle:
        sr, channels, frames = handle.samplerate, handle.channels, len(handle)
        if frames < 64 or channels not in (1, 2):
            raise ValueError("音频无法提取特征。")
        energy = np.zeros(channels, dtype=np.float64)
        peak = mid_energy = side_energy = 0.0
        buffer = np.empty(0, dtype=np.float64)
        psd_sum, windows = None, 0
        for audio in handle.blocks(blocksize=131072, dtype="float64", always_2d=True):
            if not np.isfinite(audio).all():
                raise ValueError("音频包含非有限数值。")
            energy += (audio * audio).sum(axis=0)
            peak = max(peak, float(np.abs(audio).max()))
            if channels == 2:
                mid_energy += float(np.sum((audio[:, 0] + audio[:, 1]) ** 2))
                side_energy += float(np.sum((audio[:, 0] - audio[:, 1]) ** 2))
            else:
                mid_energy += float(np.sum(audio[:, 0] ** 2)) * 4
            buffer = np.concatenate([buffer, audio.mean(axis=1)])
            if len(buffer) >= 4096:
                count = (len(buffer) - 4096) // 2048 + 1
                stop = (count - 1) * 2048 + 4096
                freqs, psd = signal.welch(buffer[:stop], fs=sr, nperseg=4096, noverlap=2048)
                psd_sum = psd * count if psd_sum is None else psd_sum + psd * count
                windows += count
                buffer = buffer[count * 2048:]
        if psd_sum is None:
            freqs, psd = signal.welch(buffer, fs=sr, nperseg=min(4096, len(buffer)))
        else:
            psd = psd_sum / windows
    rms = float(np.sqrt(energy.sum() / (frames * channels)))
    power = float(psd.sum()) + 1e-20
    seconds = frames / sr
    result = {"sample_rate": sr, "channels": channels, "duration_seconds": round(seconds, 3), "analyzed_seconds": round(seconds, 3), "rms_dbfs": round(20 * math.log10(max(rms, 1e-10)), 3), "peak_dbfs": round(20 * math.log10(max(peak, 1e-10)), 3), "crest_factor_db": round(20 * math.log10(max(peak, 1e-10) / max(rms, 1e-10)), 3), "spectral_centroid_hz": round(float((freqs * psd).sum() / power), 2)}
    left_power, right_power = energy[0] / frames, energy[-1] / frames
    result.update({"stereo_width": float(side_energy / max(mid_energy, 1e-8 * frames)), "stereo_imbalance": float((right_power - left_power) / max(right_power + left_power, 1e-8))})
    for name, low, high in [("bass_power_fraction", 20, 250), ("mid_power_fraction", 250, 4000), ("treble_power_fraction", 4000, sr / 2)]:
        result[name] = round(float(psd[(freqs >= low) & (freqs < high)].sum() / power), 5)
    return result


def apply_effect(x, sr, item):
    if not item.get("enabled", True):
        return x
    classes = {"noise_gate": "NoiseGate", "highpass": "HighpassFilter", "lowpass": "LowpassFilter", "chorus": "Chorus", "phaser": "Phaser", "pitch_shift": "PitchShift"}
    effect, parameters = item["effect"], item["parameters"]
    if effect in classes:
        import pedalboard
        result = pedalboard.Pedalboard([getattr(pedalboard, classes[effect])(**parameters)])(np.asarray(x, dtype=np.float32), sr)
    else:
        dsp = _load_dsp()
        if effect == "equalizer":
            result = dsp.parametric_eq(x, sample_rate=sr, **parameters)
        elif effect == "panner":
            result = dsp.stereo_panner(x, **parameters)
        elif effect == "stereo_widener":
            result = dsp.stereo_widener(x, **parameters)
        else:
            result = getattr(dsp, "pedalboard_" + effect)(np.asarray(x, dtype=np.float32), sample_rate=sr, **parameters)
    if not np.isfinite(result).all():
        raise ValueError(f"{effect} 产生了非有限音频，已停止导出。")
    return result


def render_routing(x, sr, plan):
    order, incoming = validate_routing(plan)
    effects = {item["id"]: item for item in plan["chain"]}
    refs = Counter(edge["source"] for edges in incoming.values() for edge in edges)
    signals = {INPUT: x}
    for node in order:
        if node == INPUT:
            continue
        edges = incoming[node]
        if node in effects or node == OUTPUT:
            source = edges[0]["source"]
            signal = signals[source]
            if node != OUTPUT and effects[node].get("enabled", True):
                # A sibling branch may still need the unprocessed buffer.
                signal = apply_effect(signal.copy(), sr, effects[node])
        else:
            channels = max(signals[edge["source"]].shape[0] for edge in edges)
            frames = max(signals[edge["source"]].shape[1] for edge in edges)
            signal = np.zeros((channels, frames), dtype=np.float32)
            for edge in edges:
                branch = signals[edge["source"]]
                signal[:, :branch.shape[1]] += branch * (10 ** (edge["gain_db"] / 20))
            if not np.isfinite(signal).all():
                raise ValueError("汇合节点产生了非有限音频，已停止导出。")
        signals[node] = signal
        for edge in edges:
            source = edge["source"]
            refs[source] -= 1
            if not refs[source]:
                del signals[source]
    return signals[OUTPUT]


def render_chain(input_path, plan, output_path, raw_output=None):
    validate_plan(plan)
    source, output = Path(input_path), Path(output_path)
    if source.resolve() == output.resolve() or (raw_output and Path(raw_output).resolve() in (source.resolve(), output.resolve())):
        raise ValueError("输出路径不能覆盖输入或其他输出。")
    audio, sr = read_audio(source)
    tail = 2.0 if any(item["effect"] in ("reverb", "delay") and item.get("enabled", True) for item in plan["chain"]) else 0.0
    x = np.pad(audio.T, ((0, 0), (0, int(sr * tail))))
    if plan.get("schema_version") == 3:
        x = render_routing(x, sr, plan)
    else:
        for item in plan["chain"]:
            x = apply_effect(x, sr, item)
    peak = float(np.abs(x).max())
    output_gain = min(1.0, 0.99 / max(peak, 1e-12))
    output.parent.mkdir(parents=True, exist_ok=True)
    if raw_output:
        sf.write(str(raw_output), x.T, sr, subtype="FLOAT")
    sf.write(str(output), (x * output_gain).T, sr, subtype="PCM_24")
    return {"sample_rate": sr, "frames": x.shape[-1], "channels": x.shape[0], "tail_seconds": tail, "output_gain_db": round(20 * math.log10(output_gain), 3), "unprotected_peak_dbfs": 20 * math.log10(peak) if peak > 1e-12 else None, "tail_policy": "fixed_2_seconds; long decays may be truncated"}


def new_run(prefix="run"):
    return ROOT / "outputs" / (prefix + "_" + datetime.now().strftime("%Y%m%d_%H%M%S_%f"))


def save_session(source, plan, directory, origin="manual", api_record=None, reference=None, task_context=None):
    from paper_tasks import validate_task
    plan = normalize_plan(plan)
    context = dict(task_context or {"task": "instruction"})
    context["reference"] = str(reference) if reference else context.get("reference")
    context.pop("analysis_start", None)
    context.pop("analysis_seconds", None)
    context.pop("reference_dry", None)
    context["analysis_scope"] = "whole_audio"
    validate_task(context.get("task", "instruction"), source, context.get("reference"))
    targets = validate_targets(context.get("targets"))
    directory = Path(directory)
    if directory.exists():
        raise ValueError("输出目录已存在，请选择新目录。")
    directory.parent.mkdir(parents=True, exist_ok=True)
    pending = directory.with_name("." + directory.name + ".pending_" + uuid.uuid4().hex[:8])
    pending.mkdir()
    try:
        audio, sr = read_audio(source)
        sf.write(str(pending / "original.wav"), audio, sr, subtype="PCM_24")
        stats = render_chain(pending / "original.wav", plan, pending / "processed.wav", pending / "render_float.wav")
        dump(pending / "chain.json", plan)
        record = {"origin": origin, "input_provenance": str(Path(source).resolve()), "audio_features": audio_features(source), **stats}
        if api_record:
            for name in ("request", "response"):
                dump(pending / ("api_" + name + ".json"), api_record[name])
            record.update({key: api_record.get(key) for key in ("requested_model", "returned_model", "usage")})
            dump(pending / "api_attempts.json", api_record.get("attempts", []))
        for key, name in [("reference", "reference.wav")]:
            if context.get(key):
                data, rate = read_audio(context[key])
                sf.write(str(pending / name), data, rate, subtype="PCM_24")
                context[key] = name
        context.pop("truth_chain", None)
        context.update({"targets": targets, "automatic_fx_removal_and_normalization": False, "audio_conditioning": "measured_statistics; no trained API adapter"})
        dump(pending / "run.json", record)
        dump(pending / "task.json", context)
        quality = analyze_audio(pending / "processed.wav", targets)
        quality["render_protection"] = {**stats, "before": analyze_audio(pending / "render_float.wav")["metrics"]}
        dump(pending / "quality.json", quality)
        dump(pending / "evaluation.json", {"quality": quality, "interpretation": "Technical checks; no overall perceptual score; no cross-content waveform comparison"})
        dump(pending / "manifest.json", {"schema_version": 2, "status": "complete", "selected": "initial", "task": context["task"]})
        os.replace(pending, directory)
    except Exception as exc:
        dump(pending / "manifest.json", {"schema_version": 2, "status": "failed", "error_type": type(exc).__name__})
        raise
    return directory


def generate(source, instruction, reference=None, *, base_url=None, model=None, current_plan=None, log=print, task="instruction", available_effects=None, feedback_rounds=1, targets=None, cancel=None, output_directory=None, allow_routing=False):
    from api_client import request_plan, BASE_URL, MODEL
    from paper_tasks import validate_task
    from feedback import refine_session
    validate_task(task, source, reference)
    targets = validate_targets(targets)
    if isinstance(feedback_rounds, bool) or feedback_rounds not in range(4):
        raise ValueError("反馈轮数应为 0–3。")
    begin = time.perf_counter()
    log("统计整段音频……")
    features = audio_features(source)
    ref_features = audio_features(reference) if reference else None
    if cancel and cancel():
        raise InterruptedError("已取消，尚未调用 API。")
    log("调用 API 规划工具实例和参数……")
    routing_option = {"allow_routing": True} if allow_routing else {}
    plan, record = request_plan(features, instruction, ref_features, base_url=base_url or BASE_URL, model=model or MODEL, current_plan=current_plan, task=task, available_effects=available_effects, targets=targets, **routing_option)
    if cancel and cancel():
        raise InterruptedError("已取消，API 请求已经完成。")
    context = {"task": task, "reference": str(reference) if reference else None, "analysis_scope": "whole_audio", "available_effects": list(available_effects) if available_effects is not None else list(RANGES), "targets": targets, "instruction": instruction}
    log("渲染初稿并测量整段输出……")
    run = save_session(source, plan, Path(output_directory) if output_directory is not None else new_run("api"), "api", record, reference, context)
    refine_session(run, instruction, base_url=base_url or BASE_URL, model=model or MODEL, rounds=feedback_rounds, targets=targets, cancel=cancel, log=log)
    log(f"结果已保存；耗时 {time.perf_counter() - begin:.1f} 秒：{run}")
    return run


def main():
    parser = argparse.ArgumentParser(description="可编辑音频处理：工具规划、结果反馈与质量检测")
    subs = parser.add_subparsers(dest="action", required=True)
    gen = subs.add_parser("generate")
    gen.add_argument("input", type=Path)
    gen.add_argument("instruction")
    gen.add_argument("--reference", type=Path)
    gen.add_argument("--effects", nargs="+", choices=list(RANGES))
    gen.add_argument("--rounds", type=int, choices=range(4), default=1)
    gen.add_argument("--lufs", type=float)
    gen.add_argument("--true-peak", type=float)
    ren = subs.add_parser("render")
    ren.add_argument("input", type=Path)
    ren.add_argument("chain", type=Path)
    ren.add_argument("output", type=Path)
    qa = subs.add_parser("quality")
    qa.add_argument("input", type=Path)
    qa.add_argument("--output", type=Path)
    listen = subs.add_parser("listen")
    listen.add_argument("run", type=Path)
    ratings = subs.add_parser("ratings")
    ratings.add_argument("directory", type=Path)
    ratings.add_argument("files", type=Path, nargs="+")
    args = parser.parse_args()
    if args.action == "generate":
        targets = {key: value for key, value in {"integrated_lufs": args.lufs, "true_peak_dbtp": args.true_peak}.items() if value is not None}
        generate(args.input, args.instruction, args.reference, available_effects=args.effects, feedback_rounds=args.rounds, targets=targets)
    elif args.action == "render":
        render_chain(args.input, json.loads(args.chain.read_text(encoding="utf-8")), args.output)
    elif args.action == "quality":
        result = analyze_audio(args.input)
        dump(args.output, result) if args.output else print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    elif args.action == "listen":
        from listening import prepare_run_listening
        print(prepare_run_listening(args.run))
    elif args.action == "ratings":
        from listening import summarize_ratings
        print(json.dumps(summarize_ratings(args.directory, args.files), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
