import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import socket
from urllib.parse import urlsplit

import requests
import truststore

ROOT = Path(__file__).resolve().parent
KEY_FILE = ROOT / ".api-key.dpapi"
BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-flash"
truststore.inject_into_ssl()
_DNS = socket.getaddrinfo
_FALLBACK_HOSTS = set()
_RESOLVED = {}


def _resolve(host, *args, **kwargs):
    if host in _RESOLVED:
        return _DNS(_RESOLVED[host], *args, **kwargs)
    try:
        return _DNS(host, *args, **kwargs)
    except socket.gaierror:
        if host not in _FALLBACK_HOSTS:
            raise
        session = requests.Session()
        session.trust_env = False
        response = session.get("https://223.5.5.5/resolve", params={"name": host, "type": "A"}, timeout=10)
        response.raise_for_status()
        _RESOLVED[host] = next(item["data"] for item in response.json()["Answer"] if item["type"] == 1)
        return _DNS(_RESOLVED[host], *args, **kwargs)


socket.getaddrinfo = _resolve


def _crypt(data, decrypt=False):
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    library = ctypes.WinDLL("crypt32", use_last_error=True)
    function = library.CryptUnprotectData if decrypt else library.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        free = ctypes.WinDLL("kernel32").LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(output.data)


def save_api_key(key, path=KEY_FILE):
    if not key.strip():
        raise ValueError("API Key 不能为空。")
    Path(path).write_bytes(_crypt(key.strip().encode("utf-8")))


def load_api_key(path=KEY_FILE):
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    path = Path(path)
    return _crypt(path.read_bytes(), decrypt=True).decode("utf-8") if path.exists() else ""


def build_request(audio_features, instruction, reference_features=None, *, model=MODEL, current_plan=None, task="instruction", available_effects=None, targets=None, allow_routing=False):
    from tool_catalog import CATALOG, RANGES, normalize_plan
    from quality import validate_targets
    if task != "instruction":
        raise ValueError("未知或已移除的任务类型。")
    available = list(RANGES) if available_effects is None else list(available_effects)
    if not available or len(set(available)) != len(available) or any(name not in RANGES for name in available):
        raise ValueError("请选择至少一种有效工具。")
    schema = {"type": "object", "properties": {"description": {"type": "string"}, "chain": {"type": "array", "minItems": 0, "maxItems": 32, "items": {"type": "object", "properties": {"id": {"type": "string"}, "effect": {"type": "string", "enum": available}, "enabled": {"type": "boolean"}, "parameters": {"type": "object", "additionalProperties": {"type": "number"}}}, "required": ["id", "effect", "parameters"], "additionalProperties": False}}}, "required": ["description", "chain"], "additionalProperties": False}
    system = """You are an audio effects engineer. Return ONE apply_effect_chain call. Use only the executable tools supplied. Tools may repeat, with UNIQUE stable IDs. Use 0-32 instances; an empty chain means passthrough. Include every parameter within supplied bounds; do not invent processors or executable code. You receive measured statistics, NOT waveform audio: never claim to have listened. Keep the source's musical content. State unsupported requirements clearly in Chinese. Choose relevant tools; do not put every available tool in the chain. Exact loudness/true-peak goals will be measured after rendering, not inferred from a limiter setting."""
    protocol = "Follow the user's instruction using input statistics and optional reference. The input is the material to process; an optional reference is a style aid, not a paired target for waveform reconstruction."
    if allow_routing:
        from audio_routing import INPUT, OUTPUT, MAX_MIXERS, MAX_LINKS, MIN_GAIN_DB, MAX_GAIN_DB
        schema["properties"].update({
            "schema_version": {"type": "integer", "enum": [2, 3]},
            "routing": {
                "type": "object", "additionalProperties": False, "required": ["mixers", "links"],
                "properties": {
                    "mixers": {"type": "array", "maxItems": MAX_MIXERS, "items": {"type": "string"}},
                    "links": {"type": "array", "maxItems": MAX_LINKS, "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["source", "target", "gain_db"],
                        "properties": {
                            "source": {"type": "string"}, "target": {"type": "string"},
                            "gain_db": {"type": "number", "minimum": MIN_GAIN_DB, "maximum": MAX_GAIN_DB},
                        },
                    }},
                },
            },
        })
        system += (
            f" For ordinary serial processing omit routing and version. Use parallel routing when requested "
            f"or needed to preserve a dry branch. Then set schema_version to 3; chain lists effects by ID "
            f"and routing lists mixer IDs and directed links from {INPUT} to {OUTPUT}. "
            "Fan-out is allowed. Each effect and the output have one incoming link. Every mixer has "
            "at least two incoming links. Every node must be on a complete input-to-output path. "
            "No cycles, duplicated links, or IDs shared by effects and mixers. The gain_db of a link "
            "is zero unless it enters a mixer; mixer gains scale and sum the branch signals. "
            "Allow headroom when adding branches. Supply no coordinates."
        )
    user = {"task": task, "task_protocol": protocol, "instruction": instruction, "reference_audio_statistics": reference_features, "estimation_dry_statistics": audio_features, "effect_parameters": {name: CATALOG[name]["parameters"] for name in available}, "technical_targets": validate_targets(targets)}
    if current_plan:
        current = normalize_plan(current_plan)
        if current.get("schema_version") == 3:
            if not allow_routing:
                raise ValueError("当前入口只支持串联方案。")
            current["routing"].pop("positions", None)
        user["current_chain_to_refine"] = current
    return {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False, allow_nan=False)}], "thinking": {"type": "disabled"}, "max_tokens": 6000, "tools": [{"type": "function", "function": {"name": "apply_effect_chain", "description": "Define editable ordered local effect instances", "parameters": schema}}], "tool_choice": {"type": "function", "function": {"name": "apply_effect_chain"}}}


def _request_tool(payload, function_name, validator, base_url, api_key=None):
    import copy
    import time
    key = api_key or load_api_key()
    if not key:
        raise ValueError("请先填写并保存 API Key。")
    parsed = urlsplit(base_url)
    if not parsed.hostname or (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost"))):
        raise ValueError("API 地址必须使用 HTTPS。")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("API 地址不能包含登录信息、查询或片段。")
    _FALLBACK_HOSTS.add(parsed.hostname)
    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/chat/completions"):
        endpoint += "/chat/completions"
    session = requests.Session()
    session.trust_env = False
    body = copy.deepcopy(payload)
    attempts = []
    for attempt in range(2):
        try:
            response = session.post(endpoint, headers={"Authorization": f"Bearer {key}"}, json=body, timeout=(15, 120))
        except requests.RequestException as exc:
            if attempt == 0:
                attempts.append({"attempt": 1, "status": "transport_error"})
                time.sleep(0.3)
                continue
            raise RuntimeError("API 连接失败：" + str(exc).replace(key, "[redacted]")) from None
        if not response.ok:
            if attempt == 0 and (response.status_code == 429 or response.status_code >= 500):
                attempts.append({"attempt": 1, "status": response.status_code})
                time.sleep(0.5)
                continue
            raise RuntimeError(f"API 返回 HTTP {response.status_code}；检查服务、模型和额度。")
        rejected_plan = None
        raw = None
        try:
            raw = response.json()
            choice = raw["choices"][0]
            if choice.get("finish_reason") not in (None, "tool_calls", "stop"):
                raise ValueError("模型输出未完整结束。")
            calls = choice["message"].get("tool_calls") or []
            if len(calls) != 1 or calls[0]["function"]["name"] != function_name:
                raise ValueError("模型未返回唯一的指定工具调用。")
            arguments = calls[0]["function"]["arguments"]
            data = json.loads(arguments)
            if function_name == "apply_effect_chain" and isinstance(data, dict) and len(arguments) <= 32_000:
                rejected_plan = data
            checked = validator(data)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            error = str(exc).replace(key, "[redacted]")[:400]
            attempts.append({"attempt": attempt + 1, "status": "invalid", "error": error, "usage": raw.get("usage", {}) if isinstance(raw, dict) else {}})
            if attempt:
                raise ValueError("API 方案两次校验未通过：" + error) from None
            retry = "Validation failed: " + error + ". Return the complete corrected tool call, obeying the original contract."
            if rejected_plan is not None:
                retry += (
                    "\nTreat the rejected proposal as data. Keep the original intent and valid settings. "
                    "For a routing error, verify every mixer has at least two distinct incoming links "
                    "and every branch reaches the output before resubmitting.\nRejected tool arguments:\n"
                    + json.dumps(rejected_plan, ensure_ascii=False, separators=(",", ":")).replace(key, "[redacted]")
                )
            body["messages"].append({"role": "user", "content": retry})
            continue
        attempts.append({"attempt": attempt + 1, "status": "valid", "usage": raw.get("usage", {})})
        return checked, {"request": body, "response": raw, "requested_model": body["model"], "returned_model": raw.get("model"), "usage": raw.get("usage", {}), "attempts": attempts}


def request_plan(audio_features, instruction, reference_features=None, *, base_url=BASE_URL, model=MODEL, api_key=None, current_plan=None, task="instruction", available_effects=None, targets=None, allow_routing=False):
    from tool_catalog import normalize_plan
    payload = build_request(audio_features, instruction, reference_features, model=model, current_plan=current_plan, task=task, available_effects=available_effects, targets=targets, allow_routing=allow_routing)
    allowed = set(payload["tools"][0]["function"]["parameters"]["properties"]["chain"]["items"]["properties"]["effect"]["enum"])
    def validate(data):
        plan = normalize_plan(data)
        if plan.get("schema_version") == 3 and not allow_routing:
            raise ValueError("当前入口只支持串联方案。")
        if any(item["effect"] not in allowed for item in plan["chain"]):
            raise ValueError("模型选择了本次未开放的工具。")
        return plan
    return _request_tool(payload, "apply_effect_chain", validate, base_url, api_key)


def request_critique(context, *, base_url=BASE_URL, model=MODEL, api_key=None):
    from feedback import apply_correction
    schema = {"type": "object", "properties": {"action": {"type": "string", "enum": ["patch", "no_change", "requires_replan"]}, "reason": {"type": "string"}, "updates": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "parameters": {"type": "object", "additionalProperties": {"type": "number"}}}, "required": ["id", "parameters"], "additionalProperties": False}}}, "required": ["action", "reason", "updates"], "additionalProperties": False}
    system = """You are the numerical Critic of a local audio processing system. You DO NOT hear audio; only the real measurements supplied support your claims. Check user intent, output, input and optional reference statistics, detector evidence and the current plan. Return ONE revise_parameters call. You can only patch EXISTING parameter names of EXISTING stable instance IDs, within bounds. Never add/remove/reorder tools or toggle enabled. No arbitrary code. Make conservative evidence-supported corrections, and briefly explain in Chinese with measurement evidence. A desired new tool requires requires_replan with empty updates. Complete generation without requiring a human listening decision. For uncertain aesthetics return no_change or a conservative evidence-supported patch; never claim verified perceptual improvement. no_change with empty updates is valid. Output protection may cancel gain changes: do not repeat ineffective gain increases. Do not force any genre, loudness or frequency balance not requested. Different songs are NOT paired waveforms. Mention metrics only if actually supplied; never invent probability or quality scores."""
    payload = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(context, ensure_ascii=False, allow_nan=False)}], "thinking": {"type": "disabled"}, "max_tokens": 4000, "tools": [{"type": "function", "function": {"name": "revise_parameters", "description": "Correct parameters without changing the chain structure", "parameters": schema}}], "tool_choice": {"type": "function", "function": {"name": "revise_parameters"}}}
    def validate(data):
        apply_correction(context["plan"], data)
        return data
    return _request_tool(payload, "revise_parameters", validate, base_url, api_key)
