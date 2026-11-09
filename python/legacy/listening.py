"""Offline blinded preference tests; no fabricated listener results or MUSHRA claim."""
import hashlib
import json
import math
from pathlib import Path
import random
import uuid

import numpy as np
import soundfile as sf

from quality import analyze_audio, dump


def prepare_listening(versions, directory):
    if len(versions) < 2 or len(versions) > 26:
        raise ValueError("盲听需要 2–26 个不同版本。")
    reports = {name: analyze_audio(path) for name, path in versions.items()}
    if any(report["metrics"]["integrated_lufs"] is None or report["metrics"]["true_peak_dbtp"] is None for report in reports.values()):
        raise ValueError("音频过短、近静音或测量不可用，无法准备可验证的等响度盲听。")
    common = min(-23.0, *(r["metrics"]["integrated_lufs"] - 1 - r["metrics"]["true_peak_dbtp"] for r in reports.values()))
    directory = Path(directory)
    if directory.exists():
        raise ValueError("盲听目录已存在；请选择新目录。")
    directory.mkdir(parents=True)
    names = list(versions)
    random.SystemRandom().shuffle(names)
    key = {"test_id": uuid.uuid4().hex, "target_lufs": common, "labels": {}, "not_a_standard_mushra_test": True}
    for index, name in enumerate(names):
        label = chr(65 + index)
        audio, sr = sf.read(str(versions[name]), dtype="float64", always_2d=True)
        gain_db = common - reports[name]["metrics"]["integrated_lufs"]
        sf.write(str(directory / (label + ".wav")), audio * 10 ** (gain_db / 20), sr, subtype="PCM_24")
        measured = analyze_audio(directory / (label + ".wav"))
        if measured["metrics"]["true_peak_dbtp"] is None or measured["metrics"]["true_peak_dbtp"] > -0.8:
            raise ValueError("预览真峰值校验未通过，未发布盲听页面。")
        key["labels"][label] = {"version": name, "source": str(Path(versions[name]).resolve()), "gain_db": gain_db, "preview_lufs": measured["metrics"]["integrated_lufs"], "preview_sha256": hashlib.sha256((directory / (label + ".wav")).read_bytes()).hexdigest()}
    dump(directory / "key.json", key)
    rows = "".join(f'<section><h2>{label}</h2><audio controls preload="metadata" src="{label}.wav"></audio><div class="scores">' + "".join(f'<label>{caption}<input type="number" min="0" max="100" data-label="{label}" data-dim="{dimension}"></label>' for dimension, caption in [("clarity", "清晰度"), ("dynamics", "动态"), ("tone", "音色"), ("space", "空间"), ("artifacts", "无伪影程度"), ("intent", "要求符合程度"), ("overall", "总体偏好（必填）")]) + '</div></section>' for label in key["labels"])
    html = '''<!doctype html><meta charset="utf-8"><title>音频盲听</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 24px;background:#f4f5f7;color:#17202c}section{background:white;border-radius:12px;padding:18px;margin:16px 0}audio{width:100%}.scores{display:flex;flex-wrap:wrap;gap:14px}label{display:grid;gap:5px}input{width:115px;padding:6px}button{padding:12px}p{line-height:1.7}</style><h1>等响度盲听对照</h1><p>所有版本使用同一响度目标。请保持设备音量不变；0–100 分，越高越好。无法判断的维度留空。此为偏好听评，不是标准 MUSHRA 或专业认证。请先填写匿名听者编号，再逐个试听。</p><label>匿名听者编号<input id="listener" maxlength="80"></label>''' + rows + '''<button id="save">下载听评 JSON</button><p id="status"></p><script>
const players=[...document.querySelectorAll('audio')];players.forEach(p=>p.addEventListener('play',()=>players.forEach(q=>{if(q!==p)q.pause()})));
document.querySelector('#save').onclick=()=>{try{let listener=document.querySelector('#listener').value.trim();if(!listener)throw Error('请填写听者编号');let scores={};document.querySelectorAll('[data-label]').forEach(x=>{let key=x.dataset.label;(scores[key]??={});if(x.value!==''){let v=Number(x.value);if(!Number.isFinite(v)||v<0||v>100)throw Error('评分应在0–100');scores[key][x.dataset.dim]=v}});if(Object.values(scores).some(x=>x.overall===undefined))throw Error('每个版本都需要总体偏好评分');let data={test_id:TEST_ID,listener,scores};let a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='ratings_'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);document.querySelector('#status').textContent='下载完成，可在程序中导入听评文件。'}catch(e){document.querySelector('#status').textContent=e.message}};
</script>'''
    html = html.replace("TEST_ID", json.dumps(key["test_id"]))
    (directory / "index.html").write_text(html, encoding="utf-8")
    return directory


def summarize_ratings(directory, files):
    if not files:
        raise ValueError("尚未导入实际听评记录。")
    directory = Path(directory)
    key = json.loads((directory / "key.json").read_text(encoding="utf-8"))
    listeners, values, records = set(), {}, []
    dimensions = {"clarity", "dynamics", "tone", "space", "artifacts", "intent", "overall"}
    for file in files:
        data = json.loads(Path(file).read_text(encoding="utf-8"))
        if data.get("test_id") != key["test_id"]:
            raise ValueError("听评不属于本次测试。")
        listener = data.get("listener")
        if not isinstance(listener, str) or not listener.strip() or listener in listeners:
            raise ValueError("听者编号为空或重复。")
        listeners.add(listener)
        scores = data.get("scores")
        if not isinstance(scores, dict) or set(scores) != set(key["labels"]):
            raise ValueError("听评版本标识不完整。")
        for label, row in scores.items():
            if not isinstance(row, dict) or "overall" not in row or not set(row) <= dimensions:
                raise ValueError("听评维度无效。")
            for dimension, score in row.items():
                if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 100:
                    raise ValueError("评分应为 0–100 的有限数值。")
                values.setdefault((label, dimension), []).append(score)
        records.append({"test_id": key["test_id"], "listener": listener, "scores": scores})
    result = {"listeners": len(listeners), "records": records, "not_a_standard_mushra_test": True, "scores": {}, "interpretation": "Actual listener responses; descriptive statistics, not proof of professional quality."}
    for (label, dimension), scores in values.items():
        mean = float(np.mean(scores))
        half = 1.96 * float(np.std(scores, ddof=1)) / math.sqrt(len(scores)) if len(scores) > 1 else None
        result["scores"].setdefault(label, {"version": key["labels"][label]["version"]})[dimension] = {"n": len(scores), "mean": mean, "min": min(scores), "max": max(scores), "normal_approximation_interval": [max(0, mean - half), min(100, mean + half)] if half is not None else None}
    dump(directory / "summary.json", result)
    return result


def prepare_run_listening(directory):
    directory = Path(directory)
    state = json.loads((directory / "feedback.json").read_text(encoding="utf-8")) if (directory / "feedback.json").exists() else {"candidates": []}
    versions = {"input": directory / "original.wav"}
    if state["candidates"]:
        versions.update({item["name"]: directory / "versions" / item["name"] / "processed.wav" for item in state["candidates"]})
    else:
        versions["processed"] = directory / "processed.wav"
    return prepare_listening(versions, directory / ("listening_" + uuid.uuid4().hex[:8]))
