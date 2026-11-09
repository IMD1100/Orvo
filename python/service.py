"""orvo JSON-lines AI service; credentials are request-local only."""
import contextlib
import copy
from functools import lru_cache
import io
import json
from pathlib import Path
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / "legacy"))

from audio_inputs import configure_cache, decode_audio, EXTENSIONS
from audio_routing import graph_plan, MAX_LINKS, MAX_MIXERS, MIN_GAIN_DB, MAX_GAIN_DB
from tool_catalog import CATALOG, DEFAULTS, NAMES, RANGES, normalize_plan
from tools_core import audio_features

_import_directory = None
_NATIVE_EXTENSIONS = {"wav", "wave", "flac", "mp3", "ogg", "aif", "aiff"}


@lru_cache(maxsize=8)
def _cached_features(path, size, modified_ns):
    return audio_features(path)


def features(path):
    source = Path(path).resolve()
    stat = source.stat()
    return copy.deepcopy(_cached_features(str(source), stat.st_size, stat.st_mtime_ns))


def prepare_import(paths):
    if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
        raise ValueError("paths 必须为音频绝对路径列表。")
    sources = []
    for path in paths:
        source = Path(path)
        if not source.is_absolute() or not source.is_file():
            raise ValueError("导入音频必须为存在的绝对文件路径。")
        if source.suffix.lower().lstrip(".") not in EXTENSIONS:
            raise ValueError("不支持此音频文件后缀。")
        sources.append(source)
    prepared = []
    for source in sources:
        if source.suffix.lower().lstrip(".") in _NATIVE_EXTENSIONS:
            prepared.append(str(source))
            continue
        if _import_directory is None:
            raise ValueError("服务音频缓存尚未初始化。")
        destination = _import_directory / uuid.uuid4().hex
        destination.mkdir()
        output = destination / (source.stem + ".wav")
        decode_audio(source, output)
        prepared.append(str(output))
    return {"paths": prepared}


def graph_schema(available=None):
    effects = list(RANGES) if available is None else available
    nodes = []
    for effect in effects:
        parameters = {
            name: {"type": "number", "minimum": bounds["min"], "maximum": bounds["max"]}
            for name, bounds in RANGES[effect].items()
        }
        nodes.append({
            "type": "object", "additionalProperties": False,
            "required": ["id", "effect", "enabled", "parameters"],
            "properties": {
                "id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                "effect": {"type": "string", "enum": [effect]},
                "enabled": {"type": "boolean"},
                "parameters": {"type": "object", "properties": parameters,
                               "required": list(parameters), "additionalProperties": False},
            },
        })
    return {
        "type": "object", "additionalProperties": False,
        "required": ["schema_version", "description", "chain", "routing"],
        "properties": {
            "schema_version": {"type": "integer", "enum": [3]},
            "description": {"type": "string"},
            "chain": {"type": "array", "maxItems": 32, "items": {"oneOf": nodes}},
            "routing": {
                "type": "object", "additionalProperties": False,
                "required": ["mixers", "links"],
                "properties": {
                    "mixers": {"type": "array", "maxItems": MAX_MIXERS,
                               "items": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"}},
                    "links": {"type": "array", "maxItems": MAX_LINKS, "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["source", "target", "gain_db"],
                        "properties": {"source": {"type": "string"}, "target": {"type": "string"},
                                       "gain_db": {"type": "number", "minimum": MIN_GAIN_DB, "maximum": MAX_GAIN_DB}},
                    }},
                    "positions": {"type": "object", "additionalProperties": {
                        "type": "array", "minItems": 2, "maxItems": 2,
                        "items": {"type": "number", "minimum": -1000000, "maximum": 1000000},
                    }},
                },
            },
        },
    }


def validate_graph(data, available=None, *, model_output=False):
    if not isinstance(data, dict) or set(data) - {"schema_version", "description", "chain", "routing"}:
        raise ValueError("FX 图包含未知字段。")
    if type(data.get("schema_version")) is not int or data["schema_version"] != 3:
        raise ValueError("FX 图必须使用 schema_version 3。")
    if model_output and (not isinstance(data.get("description"), str) or "routing" not in data):
        raise ValueError("模型必须返回说明和完整路由。")
    if "description" in data and not isinstance(data["description"], str):
        raise ValueError("FX 图说明必须为文字。")
    chain = data.get("chain")
    if not isinstance(chain, list):
        raise ValueError("FX 图缺少效果器列表。")
    for node in chain:
        if (not isinstance(node, dict) or set(node) - {"id", "effect", "enabled", "parameters"}
                or not {"id", "effect", "parameters"} <= set(node)
                or (model_output and "enabled" not in node)):
            raise ValueError("效果器节点字段不完整或包含未知字段。")
        if available is not None and node["effect"] not in available:
            raise ValueError("模型选择了本次未开放的工具。")
    result = normalize_plan(data)
    result["routing"].setdefault("positions", {})
    return result


def required_text(request, name, limit=4000):
    value = request.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{name} 必须为非空文字，最多 {limit} 字。")
    return value.strip()


def contains_secret(value, key):
    if isinstance(value, str):
        return key in value
    if isinstance(value, dict):
        return any(contains_secret(k, key) or contains_secret(v, key) for k, v in value.items())
    if isinstance(value, list):
        return any(contains_secret(item, key) for item in value)
    return False


def audio_path(request, name):
    value = required_text(request, name, 32768)
    if not Path(value).is_absolute() or not Path(value).is_file():
        raise ValueError(f"{name} 必须为存在的音频绝对路径。")
    return value


def validate_measurement(value):
    if not isinstance(value, dict) or set(value) != {"quality", "detector"}:
        raise ValueError("measurement 必须包含 quality 和 detector。")
    json.dumps(value, allow_nan=False)
    quality, detector = value["quality"], value["detector"]
    fields = {"schema_version", "scope", "meter", "metrics", "targets", "silence_intervals", "issues", "interpretation"}
    if not isinstance(quality, dict) or set(quality) != fields or type(quality["schema_version"]) is not int or quality["schema_version"] != 1 or quality["targets"] != {}:
        raise ValueError("quality 必须为无隐含目标的整段测量报告。")
    meter = quality["meter"]
    if not isinstance(meter, dict) or meter.get("status") not in ("measured", "unavailable") or set(meter) - {"status", "engine", "algorithm", "reason"}:
        raise ValueError("测量状态无效。")
    metrics = quality["metrics"]
    names = {"integrated_lufs", "lra_lu", "true_peak_dbtp", "momentary_max_lufs", "short_term_max_lufs", "sample_peak_dbfs", "rms_dbfs", "crest_db", "dc_offset", "correlation", "mono_fold_db", "channel_balance_db"}
    if not isinstance(metrics, dict) or not names <= set(metrics) or set(metrics) - names - {"band_power_fractions"}:
        raise ValueError("测量指标缺失或包含未知字段。")
    if any(number is not None and type(number) not in (int, float) for name, number in metrics.items() if name != "band_power_fractions") or type(metrics["dc_offset"]) not in (int, float) or metrics["dc_offset"] < 0:
        raise ValueError("测量指标必须为有限数值或 null。")
    if not isinstance(quality["issues"], list) or any(not isinstance(issue, dict) or not isinstance(issue.get("category"), str) for issue in quality["issues"]):
        raise ValueError("测量问题列表无效。")
    if not isinstance(detector, dict) or set(detector) != {"implementation", "issues", "always_check_user_intent"} or not isinstance(detector["issues"], list) or detector["always_check_user_intent"] is not True:
        raise ValueError("Detector 报告无效。")
    return value


def feedback_request(request):
    from feedback import accept_candidate, apply_correction, detect
    from quality import analyze_audio
    command = request["command"]
    fields = {
        "measure": {"command", "rendered", "graph"},
        "critique": {"command", "source", "instruction", "reference", "graph", "measurement", "baseUrl", "model", "apiKey"},
        "compare": {"command", "before", "after"},
    }
    if set(request) != fields[command]:
        raise ValueError("反馈请求字段不完整或包含未知字段。")
    if command == "compare":
        before, after = validate_measurement(request["before"]), validate_measurement(request["after"])
        accepted, reason = accept_candidate(before["quality"], after["quality"], {})
        return {"accepted": accepted, "reason": reason}
    graph = validate_graph(request["graph"], model_output=True)
    if command == "measure":
        quality = analyze_audio(audio_path(request, "rendered"), targets={})
        return {"quality": quality, "detector": detect(quality, graph)}
    from api_client import request_critique
    measurement = validate_measurement(request["measurement"])
    key = required_text(request, "apiKey", 8192)
    instruction = required_text(request, "instruction")
    base_url, model = required_text(request, "baseUrl", 4096), required_text(request, "model", 256)
    source = audio_path(request, "source")
    reference = audio_path(request, "reference") if request["reference"] is not None else None
    observation = {
        "instruction": instruction, "task": "instruction", "plan": graph,
        "tool_contract": {node["effect"]: CATALOG[node["effect"]]["parameters"] for node in graph["chain"]},
        "input_audio_statistics": features(source),
        "reference_audio_statistics": features(reference) if reference else None,
        "output_measurements": measurement["quality"], "detector": detect(measurement["quality"], graph), "targets": {},
    }
    decision, _ = request_critique(observation, base_url=base_url, model=model, api_key=key)
    corrected = validate_graph(apply_correction(graph, decision), model_output=True)
    result = {"decision": decision, "graph": corrected}
    if contains_secret(result, key):
        raise ValueError("API 结果包含凭据，已拒绝返回。")
    return result


def dispatch(request):
    command = request.get("command")
    if command in ("measure", "critique", "compare"):
        return feedback_request(request)
    if command == "prepare_import":
        return prepare_import(request.get("paths"))
    if command == "catalog":
        from prompt_assistant import PRESETS
        return {"catalog": copy.deepcopy(CATALOG), "labels": dict(NAMES),
                "presets": [{"label": label, "instruction": text} for label, text in PRESETS],
                "defaults": copy.deepcopy(DEFAULTS), "graphSchema": graph_schema(),
                "emptyGraph": graph_plan({"schema_version": 2, "chain": []})}
    if command == "analyze":
        return features(required_text(request, "source", 32768))
    if command == "normalize_graph":
        return validate_graph(graph_plan(normalize_plan(request.get("graph"))))
    if command not in ("plan", "optimize"):
        raise ValueError("未知 Python 命令。")
    key = required_text(request, "apiKey", 8192)
    options = {"base_url": required_text(request, "baseUrl", 4096),
               "model": required_text(request, "model", 256), "api_key": key}
    instruction = required_text(request, "instruction")
    available = request.get("availableEffects")
    if available is not None and (
            not isinstance(available, list)
            or any(not isinstance(name, str) or name not in RANGES for name in available)
            or len(available) != len(set(available))):
        raise ValueError("availableEffects 必须为不重复的已注册效果器名称。")
    if command == "optimize":
        from prompt_assistant import optimize_instruction
        reference_provided = request.get("referenceProvided", False)
        count = request.get("batchFileCount", 1)
        if type(reference_provided) is not bool or type(count) is not int or not 1 <= count <= 256:
            raise ValueError("优化请求的参考标记或音轨数量无效。")
        result, _ = optimize_instruction(
            instruction, available_effects=available, reference_provided=reference_provided,
            batch_file_count=count, **options)
    else:
        from api_client import build_request, _request_tool
        if available is None or available == []:
            available = list(RANGES)
        current = request.get("currentGraph")
        if current is not None:
            current = validate_graph(current)
        reference = request.get("reference")
        if reference is not None and (not isinstance(reference, str) or not reference.strip()):
            raise ValueError("reference 必须为空或音频路径。")
        source_features = features(required_text(request, "source", 32768))
        reference_features = features(reference) if reference else None
        payload = build_request(source_features, instruction, reference_features, model=options["model"],
                                current_plan=current, available_effects=available, allow_routing=True)
        payload["tools"][0]["function"]["parameters"] = graph_schema(available)
        payload["messages"][0]["content"] += (
            " This service requires schema_version 3 and explicit routing for EVERY plan, including serial "
            "or empty passthrough graphs. Include enabled for every effect. Obey the exact per-effect schema."
        )
        result, _ = _request_tool(payload, "apply_effect_chain",
                                  lambda data: validate_graph(data, available, model_output=True),
                                  options["base_url"], key)
    if contains_secret(result, key):
        raise ValueError("API 结果包含凭据，已拒绝返回。")
    return result


def respond(request):
    key = request.get("apiKey", "") if isinstance(request, dict) else ""
    key = key.strip() if isinstance(key, str) else ""
    try:
        if not isinstance(request, dict):
            raise ValueError("请求必须为 JSON 对象。")
        # Third-party diagnostics must never contaminate protocol or reveal request credentials.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = dispatch(request)
        response = {"ok": True, "data": result}
        json.dumps(response, allow_nan=False)
        return response
    except (ValueError, OSError) as exc:
        error = str(exc)
        if key:
            error = error.replace(key, "[redacted]")
        return {"ok": False, "error": error[:600] or "请求失败。"}
    except Exception:
        print("AI service request failed (details suppressed).", file=sys.stderr)
        return {"ok": False, "error": "AI 服务处理失败，请检查音频、依赖或 API 配置。"}


def main():
    global _import_directory
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    with tempfile.TemporaryDirectory(prefix="orvo-analysis-") as cache:
        configure_cache(cache)
        _import_directory = Path(cache)
        for line in sys.stdin:
            try:
                request = json.loads(line, parse_constant=reject_nonfinite)
            except (ValueError, RecursionError):
                response = {"ok": False, "error": "无效 JSON 请求。"}
            else:
                response = respond(request)
                del request
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


def reject_nonfinite(value):
    raise ValueError("JSON 数值必须有限。")


if __name__ == "__main__":
    main()
