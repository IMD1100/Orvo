"""LLM2Fx-Tools task protocols and reconstruction metrics, arXiv 2512.01559v2."""
import json
from pathlib import Path

import numpy as np
from scipy import signal, stats

TASKS = {"instruction": "音频处理"}
FFT_SIZES = (512, 1024, 2048)


def validate_task(task, source, reference=None):
    if task not in TASKS:
        raise ValueError("未知任务类型。")
    if not Path(source).is_file():
        raise ValueError("请选择有效的待处理音频。")
    if reference and not Path(reference).is_file():
        raise ValueError("参考音频路径无效。")


def chain_metrics(prediction, target):
    from tools_core import RANGES, validate_plan
    validate_plan(prediction)
    validate_plan(target)
    pred = {item["effect"]: item for item in prediction["chain"] if item.get("enabled", True)}
    truth = {item["effect"]: item for item in target["chain"] if item.get("enabled", True)}
    pool = list(RANGES)
    accuracy = sum((name in pred) == (name in truth) for name in pool) / len(pool)
    # Paper Appendix E: missing tools receive |tool_pool| + 1 for rank correlation.
    def ranks(items):
        ordering = {name: index + 1 for index, name in enumerate(items)}
        return [ordering.get(name, len(pool) + 1) for name in pool]
    pr, tr = ranks(pred), ranks(truth)
    correlation = float(stats.spearmanr(pr, tr).statistic) if np.std(pr) and np.std(tr) else None
    errors = []
    for name in pred.keys() & truth.keys():
        for parameter, bounds in RANGES[name].items():
            errors.append(abs(pred[name]["parameters"][parameter] - truth[name]["parameters"][parameter]) / (bounds["max"] - bounds["min"]))
    return {"presence_accuracy": accuracy, "order_spearman": correlation, "normalized_parameter_mae": float(np.mean(errors)) if errors else None, "matched_effects": sorted(pred.keys() & truth.keys()), "parameter_bounds": "current validated physical parameter ranges"}


def _stereo(audio):
    return np.repeat(audio, 2, axis=1) if audio.shape[1] == 1 else audio


def _mrs(prediction, reference, sr):
    values = []
    for channel in range(2):
        per_resolution = []
        for size in FFT_SIZES:
            x, y = prediction[:, channel], reference[:, channel]
            if len(x) < size:
                x, y = np.pad(x, (0, size - len(x))), np.pad(y, (0, size - len(y)))
            _, _, px = signal.stft(x, fs=sr, nperseg=size, noverlap=size * 3 // 4, window="hann")
            _, _, ry = signal.stft(y, fs=sr, nperseg=size, noverlap=size * 3 // 4, window="hann")
            px, ry = np.abs(px), np.abs(ry)
            convergence = np.linalg.norm(px - ry) / max(np.linalg.norm(ry), 1e-8)
            log_magnitude = np.mean(np.abs(np.log(np.maximum(px, 1e-8)) - np.log(np.maximum(ry, 1e-8))))
            per_resolution.append(float(convergence + log_magnitude))
        values.append(sum(per_resolution))
    return float(np.mean(values))


def waveform_metrics(prediction_path, reference_path, start_seconds=0, duration_seconds=10):
    from tools_core import read_audio
    prediction, sr = read_audio(prediction_path)
    reference, _ = read_audio(reference_path)
    start = int(start_seconds * sr)
    stop = min(len(prediction), len(reference), start + int(duration_seconds * sr))
    if stop - start < 64:
        raise ValueError("所选评估窗口没有足够的共同音频。")
    prediction, reference = _stereo(prediction[start:stop]), _stereo(reference[start:stop])
    # Same-content aligned audio only. Do not use waveform distances across different songs.
    pred_ms = np.column_stack([prediction[:, 0] + prediction[:, 1], prediction[:, 0] - prediction[:, 1]])
    ref_ms = np.column_stack([reference[:, 0] + reference[:, 1], reference[:, 0] - reference[:, 1]])
    return {"status": "computed", "mrs_lr": _mrs(prediction, reference, sr), "mrs_ms": _mrs(pred_ms, ref_ms, sr), "compared_seconds": (stop - start) / sr, "start_seconds": start_seconds, "fft_sizes": list(FFT_SIZES), "hop_fraction": 0.25, "epsilon": 1e-8, "resolution_reduction": "sum", "channel_reduction": "mean", "alignment": "same start time; crop to common duration; no automatic alignment", "comparability": "paper MRS formula; FFT settings specified here, not claimed identical to the paper's unpublished settings"}


def evaluate_session(directory, plan, context):
    directory = Path(directory)
    task = context.get("task", "instruction")
    start, duration = context.get("analysis_start", 0), context.get("analysis_seconds", 10)
    reference = directory / "reference.wav"
    if not reference.exists() and context.get("reference"):
        reference = Path(context["reference"])
    if task == "reverse" and reference.is_file():
        waveform = waveform_metrics(directory / "processed.wav", reference, start, duration)
        waveform["scope"] = "same_content_dry_wet_reconstruction"
    else:
        waveform = {"status": "not_applicable", "reason": "需要同内容干湿配对；不同内容的迁移输出不计算波形距离。"}
    truth_path = directory / "ground_truth_chain.json"
    chain = chain_metrics(plan, json.loads(truth_path.read_text(encoding="utf-8"))) if truth_path.is_file() else {"status": "not_available", "reason": "未提供真实效果器链标签。"}
    return {"task": task, "paper": "https://arxiv.org/html/2512.01559v2", "paper_section": "Appendix E", "waveform": waveform, "chain": chain, "interpretation": "Reconstruction distances and label agreement are not professional mixing quality scores."}
