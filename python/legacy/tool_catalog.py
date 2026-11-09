"""Validated local tools; this catalog is shared by UI, API and executor."""
import copy
import importlib.util
import math
from pathlib import Path
import re
import uuid

from audio_routing import validate_routing

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor/llm2fx-tools/llm4mp/common_utils/fx_utils/ndsp_utils"
spec = importlib.util.spec_from_file_location("fx_constants", VENDOR / "constants.py")
constants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(constants)
RANGES = copy.deepcopy(constants.pedalboard_fx_param_ranges)
for params in RANGES.values():
    for name, bounds in params.items():
        if name.endswith("q_factor"):
            bounds["min"] = 0.1
        if name.endswith("cutoff_freq"):
            bounds["min"] = max(20, bounds["min"])
NAMES = {"equalizer": "均衡器 EQ", "compressor": "压缩", "reverb": "混响", "delay": "延迟", "gain": "增益", "limiter": "限幅", "distortion": "失真", "panner": "声像", "stereo_widener": "立体声宽度", "noise_gate": "噪声门", "highpass": "高通", "lowpass": "低通", "chorus": "合唱", "phaser": "移相", "pitch_shift": "移调"}
DEFAULTS = {"gain": {"gain_db": 0}, "distortion": {"drive_db": 3}, "compressor": {"threshold_db": -18, "ratio": 3, "attack_ms": 10, "release_ms": 100}, "limiter": {"threshold_db": -1, "release_ms": 100}, "delay": {"delay_seconds": 0.25, "feedback": 0.2, "mix_ratio": 0.2}, "reverb": {"room_size": 0.4, "damping": 0.5, "width": 0.8, "mix_ratio": 0.2}, "panner": {"pan": 0}, "stereo_widener": {"width": 1}, "equalizer": {"low_gain_db": 0, "low_cutoff_freq": 150, "low_q_factor": 0.707, "mid_gain_db": 0, "mid_cutoff_freq": 1500, "mid_q_factor": 0.707, "high_gain_db": 0, "high_cutoff_freq": 8000, "high_q_factor": 0.707}, "noise_gate": {"threshold_db": -50, "ratio": 4, "attack_ms": 2, "release_ms": 100}, "highpass": {"cutoff_frequency_hz": 60}, "lowpass": {"cutoff_frequency_hz": 18000}, "chorus": {"rate_hz": 1, "depth": 0.25, "centre_delay_ms": 7, "feedback": 0.1, "mix": 0.2}, "phaser": {"rate_hz": 0.5, "depth": 0.5, "centre_frequency_hz": 1000, "feedback": 0.1, "mix": 0.2}, "pitch_shift": {"semitones": 0}}


def bounds(low, high, step):
    return {"min": low, "max": high, "step": step}


RANGES.update({"noise_gate": {"threshold_db": bounds(-100, 0, 1), "ratio": bounds(1, 20, 0.1), "attack_ms": bounds(0.1, 100, 0.1), "release_ms": bounds(1, 2000, 1)}, "highpass": {"cutoff_frequency_hz": bounds(20, 20000, 1)}, "lowpass": {"cutoff_frequency_hz": bounds(20, 20000, 1)}, "chorus": {"rate_hz": bounds(0.01, 20, 0.01), "depth": bounds(0, 1, 0.01), "centre_delay_ms": bounds(1, 30, 0.1), "feedback": bounds(-0.95, 0.95, 0.01), "mix": bounds(0, 1, 0.01)}, "phaser": {"rate_hz": bounds(0.01, 20, 0.01), "depth": bounds(0, 1, 0.01), "centre_frequency_hz": bounds(20, 20000, 1), "feedback": bounds(-0.95, 0.95, 0.01), "mix": bounds(0, 1, 0.01)}, "pitch_shift": {"semitones": bounds(-24, 24, 0.1)}})


def unit(name):
    return "dB" if name.endswith("_db") else "ms" if name.endswith("_ms") else "s" if name.endswith("seconds") else "Hz" if "freq" in name or name.endswith("_hz") else "semitones" if name == "semitones" else "ratio"


CATALOG = {name: {"name": label, "backend": "local_ndsp" if name in constants.pedalboard_fx_param_ranges else "pedalboard", "parameters": {key: {**value, "unit": unit(key), "default": DEFAULTS[name][key]} for key, value in RANGES[name].items()}} for name, label in NAMES.items()}


def default_effect(effect):
    if effect not in DEFAULTS:
        raise ValueError("未注册效果器")
    return {"id": "fx_" + uuid.uuid4().hex[:12], "effect": effect, "enabled": True, "parameters": copy.deepcopy(DEFAULTS[effect])}


def validate_plan(plan, *, draft=False):
    if not isinstance(plan, dict) or plan.get("schema_version", 2) not in (2, 3) or not isinstance(plan.get("chain"), list) or len(plan["chain"]) > 32:
        raise ValueError("方案版本应为 2 或 3，效果器实例应为 0–32 个。")
    if plan.get("schema_version", 2) == 2 and "routing" in plan:
        raise ValueError("带路由的蓝图需要方案版本 3。")
    ids = set()
    for item in plan["chain"]:
        if not isinstance(item, dict) or not isinstance(item.get("effect"), str) or item["effect"] not in RANGES:
            raise ValueError("未注册的效果器。")
        if "id" in item:
            identity = item["id"]
            if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity) or identity in ids:
                raise ValueError("效果器实例 id 无效或重复。")
            ids.add(identity)
        params = item.get("parameters")
        if not isinstance(params, dict) or set(params) != set(RANGES[item["effect"]]):
            raise ValueError("效果器参数缺失或包含多余字段。")
        if not isinstance(item.get("enabled", True), bool):
            raise ValueError("enabled 必须为布尔值。")
        for name, value in params.items():
            limits = RANGES[item["effect"]][name]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not limits["min"] <= value <= limits["max"]:
                raise ValueError(f"{item['effect']}.{name} 应在 {limits['min']}–{limits['max']} 之间。")
    if plan.get("schema_version") == 3:
        validate_routing(plan, draft=draft)
    return plan


def normalize_plan(plan, *, draft=False):
    validate_plan(plan, draft=draft)
    result = copy.deepcopy(plan)
    result.setdefault("schema_version", 2)
    ids = {item["id"] for item in result["chain"] if "id" in item}
    for index, item in enumerate(result["chain"]):
        if "id" not in item:
            identity = f"legacy_{index + 1:03d}"
            while identity in ids:
                identity += "_"
            item["id"] = identity
            ids.add(identity)
        item.setdefault("enabled", True)
    return result
