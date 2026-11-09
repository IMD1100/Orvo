"""Editable instruction presets and text-only LLM instruction refinement."""
import json

from api_client import BASE_URL, MODEL
from tool_catalog import NAMES

PRESETS = (
    ("清晰自然", "声音清晰、均衡，保留原有音色和演奏细节，强弱变化自然。"),
    ("温暖柔和", "音色温暖、柔和，中低频饱满而不浑浊，高频听起来不刺耳。"),
    ("明亮通透", "声音更明亮、通透，细节清楚，同时保留音色的厚度，避免尖锐感。"),
    ("人声突出", "人声清晰、靠前，字句容易听清，保留原有音高、情绪和演唱细节。"),
    ("吉他质感", "吉他的拨弦细节和木质感更鲜明，低频紧致、高频柔和，保留演奏的力度变化。"),
    ("鼓组冲击", "鼓点起音清楚、低频有力，节奏听起来紧凑，保留原有的强弱层次。"),
    ("低频紧实", "低频紧实、有层次，既有力度也听得清细节，避免浑浊或单薄。"),
    ("空间氛围", "空间感自然、有纵深，主体保持清楚，尾音不盖住细节，单声道听起来也清晰。"),
    ("干净克制", "声音干净、直接，响度变化自然，少有明显尾音，保留原有音色、音高和节奏。"),
)


def validate_optimized_instruction(data):
    if not isinstance(data, dict) or set(data) != {"instruction"}:
        raise ValueError("优化结果必须只包含处理要求。")
    text = data["instruction"]
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1200:
        raise ValueError("优化后的处理要求必须为 1–1200 字的文字。")
    return {"instruction": text.strip()}


def optimize_instruction(instruction, *, available_effects=None, reference_provided=False, batch_file_count=1, base_url=BASE_URL, model=MODEL, api_key=None):
    from api_client import _request_tool
    text = instruction.strip() if isinstance(instruction, str) else ""
    if not text or len(text) > 4000:
        raise ValueError("请填写处理要求，优化前不超过 4000 字。")
    available = list(NAMES) if available_effects is None else list(available_effects)
    if not available or any(name not in NAMES for name in available):
        raise ValueError("请至少选择一种有效的可用效果器。")
    context = {"original_instruction": text, "reference_provided": bool(reference_provided),
               "batch_file_count": batch_file_count, "available_effects": available}
    system = """你是音频处理要求编辑助手。沿用用户语言，只写声音目标、保留要求和用户约束，整理成简洁的 1–4 句。用可听感受说明用户想要的结果，不推荐效果器，不给出参数设置、处理顺序、分支连线或操作步骤。用户已经明确的禁止事项、程度限制和可量化结果目标要保留。用户明确指定的处理手法仅作为原有约束保留，不扩写做法，不主动补充手法。用户没说的乐器、风格、缺陷或指标不要猜测。参考音频存在时，只整理用户说过的参考意图，不声称听过或分析过。批量文件共用同一要求，不假定每个文件有同一种缺陷。不要输出评述、标题或代码。只返回一次 rewrite_audio_instruction 工具调用。"""
    schema = {"type": "object", "properties": {"instruction": {"type": "string", "minLength": 1, "maxLength": 1200}}, "required": ["instruction"], "additionalProperties": False}
    payload = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(context, ensure_ascii=False)}], "thinking": {"type": "disabled"}, "max_tokens": 1200, "tools": [{"type": "function", "function": {"name": "rewrite_audio_instruction", "description": "Clarify the user's audio processing intent without processing audio", "parameters": schema}}], "tool_choice": {"type": "function", "function": {"name": "rewrite_audio_instruction"}}}
    return _request_tool(payload, "rewrite_audio_instruction", validate_optimized_instruction, base_url, api_key)
