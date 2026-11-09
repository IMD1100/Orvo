"""Whole-export technical measurements; no aesthetic quality score."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid

import numpy as np
from scipy import signal
from audio_inputs import open_audio


def db(value):
    return float(20 * math.log10(value)) if value > 1e-12 else None


def dump(path, data):
    path = Path(path)
    content = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def validate_targets(targets=None):
    targets = dict(targets or {})
    for key, value in targets.items():
        low, high = {"integrated_lufs": (-60, 0), "true_peak_dbtp": (-20, 0)}.get(key, (1, -1))
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"无效质量目标：{key}")
    return targets


def meter_audio(path, seconds, ffmpeg=None):
    try:
        if ffmpeg is None:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        result = subprocess.run([str(ffmpeg), "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true:metadata=1,ametadata=mode=print:file=-", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=max(30, seconds * 2), creationflags=flags)
        if result.returncode:
            raise RuntimeError("FFmpeg measurement failed: " + result.stderr[-300:])
        version = subprocess.run([str(ffmpeg), "-version"], capture_output=True, text=True, creationflags=flags, timeout=10).stdout.splitlines()[0]
        summary = result.stderr[result.stderr.rfind("Summary:"):]
        def read(pattern):
            match = re.search(pattern, summary)
            value = float(match.group(1)) if match else None
            return value if value is not None and math.isfinite(value) else None
        integrated = read(r"Integrated loudness:\s+I:\s+([-\d.inf]+)")
        lra = read(r"Loudness range:\s+LRA:\s+([-\d.inf]+)")
        peak = read(r"True peak:\s+Peak:\s+([-\d.inf]+)")
        series = {key: [float(x) for x in re.findall(r"lavfi\.r128\." + key + r"=([-\d.]+)", result.stdout)] for key in ("M", "S")}
        for key in series:
            series[key] = [x for x in series[key] if x > -70 and math.isfinite(x)]
        return {"status": "measured", "engine": version, "algorithm": "FFmpeg ebur128, true-peak enabled; ITU-R BS.1770 / EBU R128"}, {"integrated_lufs": integrated if integrated is not None and integrated > -70 else None, "lra_lu": lra if seconds >= 3 and integrated is not None and integrated > -70 else None, "true_peak_dbtp": peak, "momentary_max_lufs": max(series["M"], default=None) if seconds >= 0.4 else None, "short_term_max_lufs": max(series["S"], default=None) if seconds >= 3 else None}
    except (ImportError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        return {"status": "unavailable", "reason": str(exc)}, {key: None for key in ("integrated_lufs", "lra_lu", "true_peak_dbtp", "momentary_max_lufs", "short_term_max_lufs")}


def analyze_audio(path, targets=None, ffmpeg=None):
    targets = validate_targets(targets)
    with open_audio(path) as file:
        sr, channels, frames = file.samplerate, file.channels, len(file)
        if not frames or channels not in (1, 2):
            raise ValueError("质检要求非空单声道/立体声音频。")
        energy = np.zeros(channels)
        sums = np.zeros(channels)
        cross = mono_energy = peak = 0.0
        silence, open_silence, position = [], None, 0
        psd_sum = None
        for block in file.blocks(blocksize=max(64, sr // 10), dtype="float64", always_2d=True):
            if not np.isfinite(block).all():
                raise ValueError("质检发现非有限音频。")
            n = len(block)
            energy += (block * block).sum(axis=0)
            sums += block.sum(axis=0)
            mono = block.mean(axis=1)
            mono_energy += float(mono @ mono)
            if channels == 2:
                cross += float(block[:, 0] @ block[:, 1])
            peak = max(peak, float(np.abs(block).max()))
            silent = float(np.mean(block ** 2)) < 1e-6
            if silent and open_silence is None:
                open_silence = position / sr
            if not silent and open_silence is not None:
                if position / sr - open_silence >= 0.2:
                    silence.append({"start": open_silence, "end": position / sr})
                open_silence = None
            if n >= 4096:
                frequencies, psd = signal.welch(mono, sr, nperseg=4096)
                psd_sum = psd * n if psd_sum is None else psd_sum + psd * n
            position += n
        if open_silence is not None and frames / sr - open_silence >= 0.2:
            silence.append({"start": open_silence, "end": frames / sr})
    mean = sums / frames
    average_power = float(energy.sum() / (frames * channels))
    correlation = None
    if channels == 2:
        variances = energy / frames - mean ** 2
        denominator = float(np.sqrt(max(0, variances[0] * variances[1])))
        if denominator > 1e-12:
            correlation = float(np.clip((cross / frames - mean[0] * mean[1]) / denominator, -1, 1))
    meter, metrics = meter_audio(path, frames / sr, ffmpeg)
    metrics.update({"sample_peak_dbfs": db(peak), "rms_dbfs": db(math.sqrt(average_power)), "crest_db": db(peak / math.sqrt(average_power)) if average_power > 1e-20 else None, "dc_offset": float(np.abs(mean).max()), "correlation": correlation, "mono_fold_db": db(math.sqrt(mono_energy / max(float(energy.sum() / channels), 1e-20))) if average_power > 1e-20 else None, "channel_balance_db": db(math.sqrt(energy[1] / max(energy[0], 1e-20))) if channels == 2 and energy.min() > 1e-20 else None})
    if psd_sum is not None and psd_sum.sum() > 1e-20:
        metrics["band_power_fractions"] = {name: float(psd_sum[(frequencies >= low) & (frequencies < high)].sum() / psd_sum.sum()) for name, low, high in [("bass", 20, 250), ("mid", 250, 4000), ("treble", 4000, sr / 2)]}
    issues = []
    def issue(kind, severity, value, note):
        issues.append({"id": kind, "category": kind, "severity": severity, "value": value, "evidence": note, "scope": "whole_export", "score_type": "measurement_or_heuristic_not_probability"})
    if metrics["true_peak_dbtp"] is not None and metrics["true_peak_dbtp"] > 0.1:
        issue("true_peak_over", "warning", metrics["true_peak_dbtp"], "True peak exceeds 0 dBTP; check inter-sample headroom")
    if metrics["dc_offset"] > 0.01:
        issue("dc_offset", "warning", metrics["dc_offset"], "Mean signal exceeds 0.01 full scale; may need DC removal")
    if correlation is not None and correlation < -0.5:
        issue("phase", "advisory", correlation, "Negative L/R correlation; inspect mono compatibility; may be intentional")
    if average_power < 1e-12:
        issue("silence", "advisory", None, "Near-silent output; inspect intended silence or over-gating")
    for name, target in targets.items():
        value = metrics.get(name)
        if value is None:
            issue("unmeasured_" + name, "warning", None, "Cannot verify declared target")
        elif (abs(value - target) > 0.5 if name == "integrated_lufs" else value > target + 0.1):
            issue("target_" + name, "warning", value, f"Declared target {target}; loudness tolerance 0.5 LU, true peak ceiling tolerance 0.1 dB")
    return {"schema_version": 1, "scope": {"seconds": frames / sr, "frames": frames, "sample_rate": sr, "channels": channels, "analysis": "whole_export"}, "meter": meter, "metrics": metrics, "targets": targets, "silence_intervals": silence, "issues": issues, "interpretation": "Technical measurements and warnings; not a perceptual quality score or standards certification."}


def target_distances(report, targets):
    result = {}
    for name, target in targets.items():
        value = report["metrics"].get(name)
        result[name] = None if value is None else max(0, abs(value - target) - 0.5) if name == "integrated_lufs" else max(0, value - target - 0.1)
    return result
