"""Measured Detector and constrained API Critic; not trained MixAgent weights."""
import copy
import json
import os
from pathlib import Path
import re
import shutil
import uuid

from quality import analyze_audio, dump, target_distances, validate_targets
from tool_catalog import CATALOG, normalize_plan, validate_plan


def apply_correction(plan, decision):
    result = normalize_plan(plan)
    if not isinstance(decision, dict) or set(decision) != {"action", "reason", "updates"} or not isinstance(decision["reason"], str) or not isinstance(decision["updates"], list):
        raise ValueError("修正必须包含 action、reason 和 updates。")
    action, updates = decision["action"], decision["updates"]
    if action not in ("patch", "no_change", "requires_replan") or (action != "patch" and updates):
        raise ValueError("修正 action 与更新内容不一致。")
    if action == "patch" and not updates:
        raise ValueError("patch 不能为空；无需修正请返回 no_change。")
    nodes = {item["id"]: item for item in result["chain"]}
    seen = set()
    for update in updates:
        if not isinstance(update, dict) or set(update) != {"id", "parameters"} or update["id"] not in nodes or update["id"] in seen:
            raise ValueError("修正只能引用已有且不重复的实例 id。")
        seen.add(update["id"])
        params = update["parameters"]
        node = nodes[update["id"]]
        if not isinstance(params, dict) or not params or not set(params) <= set(node["parameters"]):
            raise ValueError("修正只能修改当前实例已有参数。")
        node["parameters"].update(params)
    return validate_plan(result)


def detect(quality, plan):
    fixes = {"target_integrated_lufs": {"gain", "compressor", "limiter"}, "target_true_peak_dbtp": {"gain", "limiter"}, "true_peak_over": {"gain", "limiter"}, "dc_offset": {"highpass"}, "phase": {"stereo_widener", "panner"}, "silence": {"gain", "noise_gate"}}
    return {"implementation": "measured_rules_not_trained_mixagent_detector", "issues": [{**issue, "instance_ids": [item["id"] for item in plan["chain"] if item.get("enabled", True) and item["effect"] in fixes.get(issue["category"], set())], "automatically_fixable": any(item.get("enabled", True) and item["effect"] in fixes.get(issue["category"], set()) for item in plan["chain"])} for issue in quality["issues"]], "always_check_user_intent": True}


def accept_candidate(before, after, targets):
    technical = {"true_peak_over", "dc_offset", "silence"}
    old = {x["category"] for x in before["issues"] if x["category"] in technical}
    new = {x["category"] for x in after["issues"] if x["category"] in technical}
    if new - old:
        return False, "technical_regression"
    if before["meter"]["status"] == "measured" and after["meter"]["status"] != "measured":
        return False, "technical_regression"
    for key, floor, tolerance in [("dc_offset", 0.01, 0.0001), ("true_peak_dbtp", 0.1, 0.1)]:
        old_value, new_value = before["metrics"].get(key), after["metrics"].get(key)
        if old_value is not None and new_value is not None and new_value > max(floor, old_value + tolerance):
            return False, "technical_regression"
    previous, candidate = target_distances(before, targets), target_distances(after, targets)
    improved = False
    for key in previous:
        if candidate[key] is None or previous[key] is None:
            return False, "unmeasured_target"
        if candidate[key] > previous[key] + 0.1:
            return False, "target_regression"
        improved |= candidate[key] < previous[key] - 0.1
    if improved or old - new:
        return True, "measured_improvement"
    return True, "checks_passed"


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _snapshot(directory):
    initial = directory / "versions/initial"
    if not initial.exists():
        initial.mkdir(parents=True)
        for name in ("processed.wav", "render_float.wav", "chain.json", "quality.json", "run.json", "evaluation.json"):
            if (directory / name).exists():
                shutil.copy2(directory / name, initial / name)


def select_candidate(directory, name):
    directory = Path(directory).resolve()
    state = _read(directory / "feedback.json")
    allowed = {item["name"] for item in state["candidates"]}
    if name not in allowed or (name != "initial" and not re.fullmatch(r"round_0[1-3]", name)):
        raise ValueError("未注册的候选版本。")
    candidate = directory / "versions" / name
    required = ("processed.wav", "render_float.wav", "chain.json", "quality.json", "run.json", "evaluation.json")
    if not all((candidate / file).is_file() for file in required):
        raise ValueError("候选文件不完整。")
    normalize_plan(_read(candidate / "chain.json"))
    state["selected"] = name
    manifest = _read(directory / "manifest.json")
    previous_manifest = copy.deepcopy(manifest)
    manifest["selected"] = name
    transaction = directory / (".selection_" + uuid.uuid4().hex)
    incoming, previous = transaction / "incoming", transaction / "previous"
    incoming.mkdir(parents=True)
    previous.mkdir()
    committed, started, restored = [], False, True
    names = [*required, "feedback.json", "manifest.json"]
    try:
        for filename in required:
            shutil.copy2(candidate / filename, incoming / filename)
        dump(incoming / "feedback.json", state)
        dump(incoming / "manifest.json", manifest)
        for filename in names:
            if (directory / filename).is_file():
                shutil.copy2(directory / filename, previous / filename)
        dump(directory / "manifest.json", {**previous_manifest, "status": "selecting", "recovery": str(transaction.relative_to(directory))})
        started = True
        for filename in names:
            os.replace(incoming / filename, directory / filename)
            committed.append(filename)
    except Exception:
        if started:
            try:
                for filename in [name for name in committed if name != "manifest.json"]:
                    if (previous / filename).is_file():
                        os.replace(previous / filename, directory / filename)
                    else:
                        (directory / filename).unlink(missing_ok=True)
                os.replace(previous / "manifest.json", directory / "manifest.json")
            except OSError:
                restored = False
                dump(directory / "manifest.json", {**previous_manifest, "status": "selection_failed", "recovery": str(transaction.relative_to(directory))})
        raise
    finally:
        if restored:
            resolved = transaction.resolve()
            if resolved.parent == directory and resolved.name.startswith(".selection_"):
                shutil.rmtree(resolved, ignore_errors=True)


def refine_session(directory, instruction, *, base_url=None, model=None, rounds=1, targets=None, critic=None, cancel=None, log=print):
    from api_client import BASE_URL, MODEL, request_critique
    from tools_core import audio_features, render_chain
    if isinstance(rounds, bool) or rounds not in range(4):
        raise ValueError("反馈轮数应为 0–3。")
    directory, targets = Path(directory), validate_targets(targets)
    if (directory / "feedback.json").exists():
        raise ValueError("已有反馈记录；请另存新会话再继续，避免覆盖版本历史。")
    _snapshot(directory)
    state = {"status": "complete", "selected": "initial", "stop_reason": "disabled" if rounds == 0 else "round_limit", "candidates": [{"name": "initial", "decision": "baseline"}], "history": [], "implementation": "measured Detector + API Critic, no MixCritic weights"}
    manifest = _read(directory / "manifest.json")
    manifest["status"] = "processing"
    dump(directory / "manifest.json", manifest)
    dump(directory / "feedback.json", state)
    context = _read(directory / "task.json")
    try:
        input_features = audio_features(directory / "original.wav")
        reference = directory / context["reference"] if context.get("reference") else None
        reference_features = audio_features(reference) if reference else None
        for index in range(1, rounds + 1):
            if cancel and cancel():
                state.update(status="cancelled", stop_reason="cancelled")
                break
            plan, report = normalize_plan(_read(directory / "chain.json")), _read(directory / "quality.json")
            detector = detect(report, plan)
            observation = {"instruction": instruction, "task": context["task"], "plan": plan, "tool_contract": {item["effect"]: CATALOG[item["effect"]]["parameters"] for item in plan["chain"]}, "input_audio_statistics": input_features, "reference_audio_statistics": reference_features, "output_measurements": report, "detector": detector, "targets": targets}
            log(f"Detector 已检测整段输出；Critic 第 {index}/{rounds} 轮……")
            decision, api_record = (critic or request_critique)(observation, base_url=base_url or BASE_URL, model=model or MODEL)
            corrected = apply_correction(plan, decision)
            entry = {"round": index, "detector": detector, "decision": decision}
            state["history"].append(entry)
            if api_record:
                dump(directory / f"critic_{index:02d}.json", api_record)
            if decision["action"] != "patch":
                state["stop_reason"] = decision["action"]
                break
            if corrected == plan:
                state["stop_reason"] = "unchanged_parameters"
                break
            if cancel and cancel():
                state.update(status="cancelled", stop_reason="cancelled_after_api")
                break
            name = f"round_{index:02d}"
            folder = directory / "versions" / name
            folder.mkdir()
            stats = render_chain(directory / "original.wav", corrected, folder / "processed.wav", folder / "render_float.wav")
            quality = analyze_audio(folder / "processed.wav", targets)
            quality["render_protection"] = {**stats, "before": analyze_audio(folder / "render_float.wav")["metrics"]}
            dump(folder / "quality.json", quality)
            dump(folder / "chain.json", corrected)
            dump(folder / "evaluation.json", {"quality": quality})
            dump(folder / "run.json", {**_read(directory / "run.json"), **stats, "origin": "critic", "version": name})
            adopted, reason = accept_candidate(report, quality, targets)
            entry.update(candidate=name, adopted=adopted, selection_reason=reason)
            state["candidates"].append({"name": name, "decision": reason, "reason": decision["reason"]})
            dump(directory / "feedback.json", state)
            if cancel and cancel():
                state.update(status="cancelled", stop_reason="cancelled_after_render")
                break
            if adopted:
                select_candidate(directory, name)
                state["selected"] = name
                log("已自动采用通过检查的修订。" if reason == "checks_passed" else "已自动采用技术目标得到改善的修订。")
            else:
                state["stop_reason"] = reason
                break
    except Exception as exc:
        state.update(status="partial", stop_reason="feedback_error", error=f"{type(exc).__name__}: {exc}")
        if _read(directory / "manifest.json").get("status") in ("selection_failed", "selecting"):
            state["status"] = "failed"
        log("反馈未完成，保留已有可用结果：" + type(exc).__name__)
    dump(directory / "feedback.json", state)
    manifest.update(status=state["status"], selected=state["selected"])
    dump(directory / "manifest.json", manifest)
    return state
