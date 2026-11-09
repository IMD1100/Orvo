use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiContext {
    instruction: String,
    reference: Option<String>,
    rounds: u8,
    available_effects: Vec<String>,
}

impl AiContext {
    pub fn into_value(self) -> Result<Value, String> {
        if self.instruction.chars().count() > 4000
            || self.rounds > 3
            || self.available_effects.len() > 32
            || self.available_effects.iter().any(|effect| {
                effect.is_empty()
                    || effect.len() > 64
                    || !effect
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            })
        {
            return Err("AI 处理设置无效".into());
        }
        if let Some(reference) = &self.reference {
            if !Path::new(reference).is_absolute() {
                return Err("参考音频路径无效".into());
            }
        }
        serde_json::to_value(self).map_err(|e| e.to_string())
    }
}

fn resolve_media(parent: &Path, source: &str) -> Result<Value, String> {
    let source = PathBuf::from(source);
    let resolved = if source.is_absolute() {
        source
    } else {
        parent.join(source)
    };
    let absolute = resolved
        .canonicalize()
        .map_err(|_| "工程引用的音频文件不存在")?;
    Ok(Value::String(absolute.to_string_lossy().into_owned()))
}

pub fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("保存位置无效")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, value).map_err(|e| e.to_string())?;
    temporary.flush().map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut project: Value = serde_json::from_slice(&bytes).map_err(|_| "工程 JSON 无效")?;
    if project["schemaVersion"] != 1 {
        return Err("暂不支持此工程版本".into());
    }
    let parent = path.parent().ok_or("工程位置无效")?;
    let tracks = project["tracks"].as_array_mut().ok_or("工程缺少轨道")?;
    for track in tracks {
        if let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) {
            for clip in clips.iter_mut() {
                clip["source"] = resolve_media(parent, clip["source"].as_str().ok_or("片段缺少音频路径")?)?;
            }
            track["source"] = clips.first().map(|clip| clip["source"].clone()).unwrap_or(Value::Null);
        } else if !track.get("source").is_some_and(Value::is_null) {
            track["source"] = resolve_media(parent, track["source"].as_str().ok_or("轨道缺少音频路径")?)?;
        }
    }
    if let Some(value) = project.get("ai") {
        let mut context: AiContext =
            serde_json::from_value(value.clone()).map_err(|_| "工程内的 AI 设置无效")?;
        if let Some(reference) = &context.reference {
            context.reference = resolve_media(parent, reference)?
                .as_str()
                .map(str::to_owned);
        }
        project["ai"] = context.into_value()?;
    }
    Ok(project)
}

pub fn save(path: &Path, mut project: Value) -> Result<(), String> {
    let parent = path.parent().ok_or("工程位置无效")?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("工程文件名无效")?;
    let assets_name = format!("{stem}.assets");
    project["name"] = Value::String(stem.to_owned());
    let assets = parent.join(&assets_name);
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let tracks = project["tracks"].as_array_mut().ok_or("工程缺少轨道")?;
    for track in tracks {
        if let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) {
            for clip in clips.iter_mut() {
                let source = clip["source"].as_str().ok_or("片段缺少音频路径")?;
                clip["source"] = store_media(Path::new(source), &assets, &assets_name)?;
            }
            track["source"] = clips.first().map(|clip| clip["source"].clone()).unwrap_or(Value::Null);
        } else if !track.get("source").is_some_and(Value::is_null) {
            let source = track["source"].as_str().ok_or("轨道缺少音频路径")?;
            track["source"] = store_media(Path::new(source), &assets, &assets_name)?;
        }
    }
    if let Some(reference) = project["ai"]["reference"].as_str() {
        project["ai"]["reference"] = store_media(Path::new(reference), &assets, &assets_name)?;
    }
    atomic_json(path, &project)
}

fn store_media(source: &Path, assets: &Path, assets_name: &str) -> Result<Value, String> {
    let mut input = std::fs::File::open(&source).map_err(|_| "无法读取轨道音频")?;
    let mut copy = tempfile::NamedTempFile::new_in(&assets).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 65536];
    loop {
        let size = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
        copy.write_all(&buffer[..size]).map_err(|e| e.to_string())?;
    }
    let original = source.file_name().and_then(|name| name.to_str()).ok_or("音频文件名无效")?;
    let stem = source.file_stem().and_then(|name| name.to_str()).ok_or("音频文件名无效")?;
    let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("");
    if extension.len() > 12 || !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("音频文件扩展名无效".into());
    }
    let digest = hash.finalize();
    let mut number = 1;
    loop {
        let name = if number == 1 { original.to_owned() } else if extension.is_empty() {
            format!("{stem} ({number})")
        } else { format!("{stem} ({number}).{extension}") };
        let target = assets.join(&name);
        if !target.exists() {
            copy.flush().map_err(|e| e.to_string())?;
            copy.as_file().sync_all().map_err(|e| e.to_string())?;
            match copy.persist_noclobber(&target) {
                Ok(_) => return Ok(Value::String(format!("{assets_name}/{name}"))),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => { copy = error.file; },
                Err(error) => return Err(error.error.to_string()),
            }
        } else {
            let mut existing = std::fs::File::open(&target).map_err(|e| e.to_string())?;
            let mut existing_hash = Sha256::new();
            loop {
                let size = existing.read(&mut buffer).map_err(|e| e.to_string())?;
                if size == 0 { break; }
                existing_hash.update(&buffer[..size]);
            }
            if existing_hash.finalize() == digest { return Ok(Value::String(format!("{assets_name}/{name}"))); }
            number += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn media_names_survive_and_collisions_do_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a"); let b = dir.path().join("b");
        std::fs::create_dir(&a).unwrap(); std::fs::create_dir(&b).unwrap();
        let first = a.join("人声.wav"); let second = b.join("人声.wav");
        std::fs::write(&first, b"first").unwrap(); std::fs::write(&second, b"second").unwrap();
        let target = dir.path().join("混音.orvo");
        let value = json!({"schemaVersion":1,"tracks":[{"clips":[{"source":first},{"source":second},{"source":first}]}]});
        save(&target, value.clone()).unwrap(); save(&target, value).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        let clips = saved["tracks"][0]["clips"].as_array().unwrap();
        assert_eq!(saved["name"], "混音");
        assert_eq!(clips[0]["source"], "混音.assets/人声.wav");
        assert_eq!(clips[1]["source"], "混音.assets/人声 (2).wav");
        assert_eq!(clips[2]["source"], clips[0]["source"]);
        let reopened = read(&target).unwrap();
        assert_eq!(std::fs::read(reopened["tracks"][0]["clips"][1]["source"].as_str().unwrap()).unwrap(), b"second");
    }

    #[test]
    fn project_reopens_every_clip_and_keeps_positions() {
        let folder = tempfile::tempdir().unwrap();
        let first = folder.path().join("first.wav");
        let second = folder.path().join("second.wav");
        std::fs::write(&first, b"first audio").unwrap();
        std::fs::write(&second, b"second audio").unwrap();
        let target = folder.path().join("clips.sona.json");
        let project = json!({"schemaVersion":1,"tracks":[{"source":first,"clips":[
            {"id":"a","name":"主唱","source":first,"start":0}, {"id":"b","source":second,"start":1500}
        ]}],"master":{"gainDb":0}});
        save(&target, project).unwrap();
        let reopened = read(&target).unwrap();
        let clips = reopened["tracks"][0]["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0]["name"], "主唱");
        assert_eq!(clips[1]["start"], 1500);
        assert_eq!(reopened["tracks"][0]["source"], clips[0]["source"]);
        assert_eq!(std::fs::read(clips[0]["source"].as_str().unwrap()).unwrap(), b"first audio");
        assert_eq!(std::fs::read(clips[1]["source"].as_str().unwrap()).unwrap(), b"second audio");
    }

    #[test]
    fn project_reopens_relative_media_and_keeps_previous_save_on_error() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.wav");
        std::fs::write(&source, b"audio fixture").unwrap();
        let reference = folder.path().join("reference.wav");
        std::fs::write(&reference, b"reference fixture").unwrap();
        let target = folder.path().join("session.sona.json");
        let project = json!({"schemaVersion":1,"tracks":[{"source":source}],"master":{"gainDb":-3},
                  "ai":{"instruction":"clearer", "reference":reference,"rounds":2,"availableEffects":["pitch_shift"]}});
        save(&target, project.clone()).unwrap();
        assert_eq!(read(&target).unwrap()["master"]["gainDb"], -3);
        let reopened = read(&target).unwrap();
        assert_eq!(reopened["ai"]["rounds"], 2);
        let saved_reference = Path::new(reopened["ai"]["reference"].as_str().unwrap());
        assert_ne!(saved_reference, reference);
        assert_eq!(
            std::fs::read(saved_reference).unwrap(),
            b"reference fixture"
        );
        let stored = std::fs::read(&target).unwrap();
        let mut invalid = project;
        invalid["tracks"][0]["source"] = json!("does-not-exist.wav");
        assert!(save(&target, invalid).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), stored);
    }
}
