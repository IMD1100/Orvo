#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod processor;
mod project;
mod runtime;
mod settings;
#[cfg(test)]
mod stage2_integration;
mod worker;

use runtime::Runtime;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Manager, State};

type AppState = Arc<Runtime>;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn engine(state: State<'_, AppState>, request: Value) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || runtime.engine_request(&request)).await
}

#[tauri::command]
async fn ai(state: State<'_, AppState>, request: Value) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || runtime.ai_request(request)).await
}

#[tauri::command]
async fn analyze_track(state: State<'_, AppState>, track_id: String) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || runtime.analyze_track(&track_id)).await
}

#[tauri::command]
async fn run_ai(state: State<'_, AppState>, request: processor::Request) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || runtime.run_processing(request)).await
}

#[tauri::command]
fn get_processing(state: State<'_, AppState>) -> Result<processor::Progress, String> {
    state.processing_state()
}

#[tauri::command]
async fn cancel_ai(state: State<'_, AppState>) -> Result<bool, String> {
    let runtime = state.inner().clone();
    blocking(move || runtime.cancel_processing()).await
}

#[tauri::command]
async fn open_fx_plan(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<Value>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("效果器方案", &["json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    let runtime = state.inner().clone();
    blocking(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1_048_576 {
            return Err("效果器方案文件过大".into());
        }
        let json = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let graph: Value = serde_json::from_slice(json).map_err(|_| "效果器方案 JSON 无效")?;
        runtime
            .ai_request(json!({"command":"normalize_graph","graph":graph}))
            .map(Some)
    })
    .await
}

#[tauri::command]
async fn save_fx_plan(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    graph: Value,
) -> Result<Option<String>, String> {
    let runtime = state.inner().clone();
    let graph =
        blocking(move || runtime.ai_request(json!({"command":"normalize_graph","graph":graph})))
            .await?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("效果器方案", &["json"])
        .set_file_name("chain.json")
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let mut path = file.path().to_owned();
    if path.extension().is_none() {
        path.set_extension("json");
        if path.exists() {
            return Err("同名方案已存在，请选择其他名称".into());
        }
    }
    blocking(move || {
        project::atomic_json(&path, &graph)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn pick_audio(window: tauri::WebviewWindow) -> Option<Vec<String>> {
    rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter(
            "音频文件",
            &[
                "wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "oga", "m4a", "aac",
                "opus", "wma", "caf",
            ],
        )
        .pick_files()
        .await
        .map(|files| {
            files
                .iter()
                .map(|file| file.path().to_string_lossy().into_owned())
                .collect()
        })
}

#[tauri::command]
async fn pick_export(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("WAV", &["wav"])
        .set_file_name("混音.wav")
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let mut path = file.path().to_owned();
    if path.extension().is_none() {
        path.set_extension("wav");
        if path.exists() {
            return Err("同名文件已存在，请选择其他名称".into());
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_reference(window: tauri::WebviewWindow) -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter(
            "参考音频",
            &[
                "wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "oga", "m4a", "aac",
                "opus", "wma", "caf",
            ],
        )
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_project(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<Value>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("orvo 工程", &["orvo", "sona.json", "json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    let runtime = state.inner().clone();
    blocking(move || {
        let mut project = project::read(&path)?;
        if let Some(file) = path.file_name().and_then(|name| name.to_str()) {
            let name = file.strip_suffix(".sona.json").or_else(|| file.strip_suffix(".orvo")).or_else(|| file.strip_suffix(".json")).unwrap_or(file);
            project["name"] = json!(name);
        }
        let loaded =
            runtime.engine_request(&json!({"command":"load_project","project":project}))?;
        *runtime.project_path.lock().map_err(|_| "工程路径不可用")? = Some(path);
        runtime.log("工程已打开");
        Ok(Some(loaded))
    })
    .await
}

#[tauri::command]
async fn save_project(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    project: Value,
    ai_context: Option<project::AiContext>,
) -> Result<Option<String>, String> {
    if project["schemaVersion"] != 1 {
        return Err("工程版本无效".into());
    }
    let runtime = state.inner().clone();
    let mut snapshot =
        blocking(move || runtime.engine_request(&json!({"command":"project"}))).await?;
    if let Some(context) = ai_context {
        snapshot["ai"] = context.into_value()?;
    }
    let existing = state.inner().project_path.lock().map_err(|_| "工程路径不可用")?.clone();
    let path = if let Some(path) = existing { path } else {
        let Some(file) = rfd::AsyncFileDialog::new().set_parent(&window)
            .add_filter("orvo 工程", &["orvo"])
            .set_file_name("未命名.orvo").save_file().await else { return Ok(None); };
        let mut path = file.path().to_owned();
        if path.extension().is_none() {
            path.set_extension("orvo");
            if path.exists() { return Err("同名工程已存在，请选择其他名称".into()); }
        }
        let stem = path.file_stem().ok_or("工程文件名无效")?.to_owned();
        let parent = path.parent().ok_or("保存位置无效")?;
        let folder = parent.join(&stem);
        let project_file = folder.join(path.file_name().ok_or("工程文件名无效")?);
        if project_file.exists() { return Err("同名工程已存在，请选择其他名称".into()); }
        project_file
    };
    let runtime = state.inner().clone();
    blocking(move || {
        project::save(&path, snapshot)?;
        *runtime.project_path.lock().map_err(|_| "工程路径不可用")? = Some(path.clone());
        runtime.log("工程与音频资源已保存");
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn save_track_result(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    track_id: String,
    ai_context: project::AiContext,
) -> Result<Option<String>, String> {
    let Some(parent) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let parent = parent.path().to_owned();
    let runtime = state.inner().clone();
    blocking(move || {
        let destination = runtime.save_track_result(&parent, &track_id, ai_context)?;
        Ok(Some(destination.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || {
        let mut settings = settings::read(&runtime.settings_path())?;
        settings.device_id = runtime
            .device_id
            .lock()
            .map_err(|_| "设备状态不可用")?
            .clone();
        let mut public = serde_json::to_value(settings).map_err(|e| e.to_string())?;
        public["hasKey"] = json!(settings::api_key().is_ok());
        Ok(public)
    })
    .await
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    settings: settings::SettingsDraft,
) -> Result<Value, String> {
    let runtime = state.inner().clone();
    blocking(move || {
        let mut validated = settings.validate()?;
        let before = runtime
            .device_id
            .lock()
            .map_err(|_| "设备状态不可用")?
            .clone();
        if validated.device_id != before {
            runtime.engine_request(&json!({"command":"set_device","id":validated.device_id}))?;
            *runtime.device_id.lock().map_err(|_| "设备状态不可用")? = validated.device_id.clone();
        }
        if !settings.key.trim().is_empty() {
            settings::save_key(&settings.key)?;
        }
        let selected_device = validated.device_id.clone();
        validated.device_id.clear();
        let mut public = serde_json::to_value(validated).map_err(|e| e.to_string())?;
        project::atomic_json(&runtime.settings_path(), &public)?;
        public["deviceId"] = json!(selected_device);
        public["hasKey"] = json!(settings::api_key().is_ok());
        runtime.log("设置已保存");
        Ok(public)
    })
    .await
}

#[tauri::command]
fn get_logs(state: State<'_, AppState>) -> Vec<String> {
    state
        .logs
        .lock()
        .map(|logs| logs.iter().cloned().collect())
        .unwrap_or_default()
}

fn main() {
    let root = match runtime::project_root() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let runtime = Arc::new(Runtime::new(root));
    if std::env::args().any(|argument| argument == "--check-services") {
        let result = runtime
            .engine_request(&json!({"command":"project"}))
            .and_then(|_| runtime.ai_request(json!({"command":"catalog"})));
        runtime.shutdown();
        match result {
            Ok(_) => println!("Native engine and Python service responded successfully."),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let cleanup = runtime.clone();
    let application = tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            engine,
            ai,
            analyze_track,
            run_ai,
            cancel_ai,
            get_processing,
            open_fx_plan,
            save_fx_plan,
            pick_audio,
            pick_export,
            pick_reference,
            open_project,
            save_project,
            save_track_result,
            get_settings,
            save_settings,
            get_logs
        ])
        .build(tauri::generate_context!())
        .expect("无法初始化 orvo 桌面窗口");
    application.run(move |app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            cleanup.shutdown();
            app.state::<AppState>().shutdown();
        }
    });
}
