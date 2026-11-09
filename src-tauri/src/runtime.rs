use crate::{processor, project, settings, worker::WorkerLane};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

pub struct Runtime {
    pub root: PathBuf,
    pub engine: WorkerLane,
    renderer: WorkerLane,
    device_scanner: WorkerLane,
    python: WorkerLane,
    processing: Mutex<processor::Progress>,
    project_edit: Mutex<()>,
    closing: AtomicBool,
    cancel_requested: AtomicBool,
    pub logs: Mutex<VecDeque<String>>,
    pub device_id: Mutex<String>,
    pub project_path: Mutex<Option<PathBuf>>,
}

impl Runtime {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            engine: WorkerLane::default(),
            renderer: WorkerLane::default(),
            device_scanner: WorkerLane::default(),
            python: WorkerLane::default(),
            processing: Mutex::new(processor::Progress::default()),
            project_edit: Mutex::new(()),
            closing: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            logs: Mutex::new(VecDeque::new()),
            device_id: Mutex::new(String::new()),
            project_path: Mutex::new(None),
        }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.root.join(".user/settings.json")
    }

    pub fn log(&self, message: impl Into<String>) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push_back(format!("[{}] {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), message.into()));
            if logs.len() > 300 {
                logs.pop_front();
            }
        }
    }

    fn engine_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = std::env::var_os("ORVO_ENGINE") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path);
            }
        }
        let name = if cfg!(windows) {
            "orvo-engine.exe"
        } else {
            "orvo-engine"
        };
        let candidates = [
            self.root
                .join("engine/build-stage2/orvo-engine_artefacts/Release")
                .join(name),
            self.root.join("bin").join(name),
            self.root
                .join("engine/build/orvo-engine_artefacts/Release")
                .join(name),
            self.root
                .join("engine/build/orvo-engine_artefacts")
                .join(name),
            self.root.join("engine/build/Release").join(name),
            self.root.join("engine/build").join(name),
        ];
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .ok_or_else(|| "未找到原生音频引擎。请先运行构建脚本".into())
    }

    pub fn engine_request(&self, request: &Value) -> Result<Value, String> {
        let command = request["command"].as_str().ok_or("引擎命令无效")?;
        if !matches!(
            command,
            "import"
                | "add_track"
                | "move_clip"
                | "duplicate_track"
                | "remove_track"
                | "paste_track"
                | "restore_tracks"
                | "project"
                | "load_project"
                | "set_track"
                | "set_graph_positions"
                | "set_master"
                | "play"
                | "pause"
                | "stop"
                | "seek"
                | "set_loop"
                | "state"
                | "set_spectrum"
                | "preview_graph"
                | "devices"
                | "set_device"
                | "export"
                | "export_track"
        ) {
            return Err("未知的引擎命令".into());
        }
        let _edit = if matches!(
            command,
            "import" | "add_track" | "move_clip" | "duplicate_track" | "remove_track" | "paste_track" | "restore_tracks" | "load_project" | "set_track" | "set_graph_positions" | "set_master" | "set_device" | "set_loop"
        ) {
            let lock = self.project_edit.lock().map_err(|_| "工程状态不可用")?;
            if self.processing_state()?.active {
                return Err("AI 正在处理，请完成后再修改工程".into());
            }
            Some(lock)
        } else {
            None
        };
        let mut prepared;
        let request = if command == "import" && !native_import(&request["paths"]) {
            let media = self.ai_request(json!({
                "command":"prepare_import", "paths":request["paths"]
            }))?;
            prepared = request.clone();
            prepared["paths"] = media["paths"].clone();
            &prepared
        } else {
            request
        };
        let lane = if command == "devices" { &self.device_scanner } else { &self.engine };
        let result = lane.request(&self.engine_path()?, &[], &self.root, request);
        if !matches!(command, "state" | "project" | "preview_graph") {
            self.log(format!(
                "音频操作 {command} {}",
                if result.is_ok() { "完成" } else { "失败" }
            ));
        }
        result
    }

    fn python_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = std::env::var_os("ORVO_PYTHON") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path);
            }
        }
        let portable = self.root.join(if cfg!(windows) { "python/runtime/python.exe" } else { "python/runtime/bin/python3" });
        if portable.is_file() { return Ok(portable); }
        let relative = if cfg!(windows) {
            "python/.venv/Scripts/python.exe"
        } else {
            "python/.venv/bin/python"
        };
        let path = self.root.join(relative);
        if path.is_file() {
            Ok(path)
        } else {
            Err("未找到 Python 服务环境。请先运行构建脚本".into())
        }
    }

    pub fn ai_request(&self, mut request: Value) -> Result<Value, String> {
        let command = request["command"].as_str().ok_or("AI 命令无效")?.to_owned();
        if !matches!(
            command.as_str(),
            "catalog"
                | "analyze"
                | "plan"
                | "optimize"
                | "prepare_import"
                | "measure"
                | "critique"
                | "compare"
                | "normalize_graph"
        ) {
            return Err("未知的 AI 命令".into());
        }
        let mut key = String::new();
        if matches!(command.as_str(), "plan" | "optimize" | "critique") {
            let settings = settings::read(&self.settings_path())?;
            key = settings::api_key()?;
            request["baseUrl"] = json!(settings.base_url);
            request["model"] = json!(settings.model);
            request["apiKey"] = json!(key);
        }
        let service = self.root.join("python/service.py");
        let args = vec!["-u".into(), service.to_string_lossy().into_owned()];
        let started = Instant::now();
        let result = self
            .python
            .request(&self.python_path()?, &args, &self.root, &request)
            .map_err(|error| {
                if key.is_empty() {
                    error
                } else {
                    error.replace(&key, "***")
                }
            });
        self.log(format!(
            "AI 操作 {command} {} · {:.2} 秒",
            if result.is_ok() { "完成" } else { "失败" }, started.elapsed().as_secs_f64()
        ));
        result
    }

    pub fn analyze_track(&self, track_id: &str) -> Result<Value, String> {
        let project = self.engine_request(&json!({"command":"project"}))?;
        let track = project["tracks"].as_array().ok_or("工程缺少轨道")?.iter()
            .find(|track| track["id"] == track_id).ok_or("音轨不存在")?;
        let source = track["source"].as_str().ok_or("请选择有音频素材的轨道")?;
        let complex = track["clips"].as_array().is_some_and(|clips| clips.len() > 1 || clips.first().is_some_and(|clip| clip["start"].as_f64().unwrap_or(0.0) > 0.0));
        if !complex { return self.ai_request(json!({"command":"analyze","source":source})); }
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let path = folder.path().join("dry.wav");
        let graph = json!({"schema_version":3,"chain":[],"routing":{"mixers":[],"positions":{},"links":[{"source":"@input","target":"@output","gain_db":0}]}});
        self.renderer.request(&self.engine_path()?, &[], &self.root,
            &json!({"command":"render_candidate","project":project,"trackId":track_id,"graph":graph,"path":path}))?;
        self.ai_request(json!({"command":"analyze","source":path}))
    }

    pub fn processing_state(&self) -> Result<processor::Progress, String> {
        self.processing
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "处理状态不可用".into())
    }

    pub fn cancel_processing(&self) -> Result<bool, String> {
        let state = self.processing.lock().map_err(|_| "处理状态不可用")?;
        if state.active {
            self.cancel_requested.store(true, Ordering::Release);
        }
        Ok(state.active)
    }

    pub fn save_track_result(
        &self,
        parent: &Path,
        track_id: &str,
        ai_context: project::AiContext,
    ) -> Result<PathBuf, String> {
        let mut snapshot = self.engine_request(&json!({"command":"project"}))?;
        let mut track = snapshot["tracks"]
            .as_array()
            .ok_or("工程缺少轨道")?
            .iter()
            .find(|track| track["id"] == track_id)
            .cloned()
            .ok_or("音轨不存在")?;
        if !track["source"].is_string() {
            return Err("空音轨没有可保存的处理结果".into());
        }
        track["muted"] = json!(false);
        track["solo"] = json!(false);
        let graph = track["graph"].clone();
        snapshot["tracks"] = json!([track]);
        snapshot["master"] = json!({"gainDb":0,"muted":false,"fxEnabled":true,"graph":{
            "schema_version":3,"chain":[],"routing":{"mixers":[],"positions":{},
            "links":[{"source":"@input","target":"@output","gain_db":0}]}
        }});
        snapshot["ai"] = ai_context.into_value()?;
        let temporary = tempfile::Builder::new()
            .prefix(".orvo-result-")
            .tempdir_in(parent)
            .map_err(|e| e.to_string())?;
        let id = temporary
            .path()
            .file_name()
            .ok_or("结果目录无效")?
            .to_string_lossy();
        let destination = parent.join(format!("orvo_{}", id.trim_start_matches(".orvo-result-")));
        let pending = temporary.path().join("result");
        std::fs::create_dir(&pending).map_err(|e| e.to_string())?;
        project::save(&pending.join("result.orvo"), snapshot.clone())?;
        project::atomic_json(&pending.join("chain.json"), &graph)?;
        self.renderer.request(&self.engine_path()?, &[], &self.root,
            &json!({"command":"export_track","project":snapshot,"id":track_id,"path":pending.join("processed.wav")}))?;
        if destination.exists() {
            return Err("同名结果目录已存在".into());
        }
        std::fs::rename(&pending, &destination).map_err(|e| e.to_string())?;
        Ok(destination)
    }

    pub fn run_processing(&self, request: processor::Request) -> Result<Value, String> {
        {
            let _edit = self.project_edit.lock().map_err(|_| "工程状态不可用")?;
            let mut state = self.processing.lock().map_err(|_| "处理状态不可用")?;
            if self.closing.load(Ordering::Acquire) {
                return Err("应用正在关闭".into());
            }
            if state.active {
                return Err("已有 AI 任务正在处理".into());
            }
            self.cancel_requested.store(false, Ordering::Release);
            *state = processor::Progress {
                active: true,
                total: request.track_ids.len(),
                rounds: request.rounds,
                phase: "planning",
                ..processor::Progress::default()
            };
        }
        let started = Instant::now();
        let result = (|| {
            let project = self.engine_request(&json!({"command":"project"}))?;
            let folder = tempfile::Builder::new()
                .prefix("orvo-feedback-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            processor::run(self, project, request, folder.path())
        })();
        if let Ok(mut state) = self.processing.lock() {
            state.active = false;
            if result.is_err() {
                state.phase = "failed";
            } else if result
                .as_ref()
                .is_ok_and(|value| value["cancelled"] == true)
            {
                state.phase = "cancelled";
            }
        }
        if let Ok(value) = &result {
            if let Some(items) = value["items"].as_array() {
                for item in items {
                    self.log(format!(
                        "AI 结果 · {} · {}",
                        item["label"].as_str().unwrap_or("音轨"),
                        item["stopReason"].as_str().unwrap_or("")
                    ));
                }
            }
        }
        self.log(format!("AI 处理耗时 · {:.2} 秒", started.elapsed().as_secs_f64()));
        result
    }

    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        self.engine.shutdown();
        self.renderer.shutdown();
        self.device_scanner.shutdown();
        self.python.shutdown();
    }
}

impl processor::Backend for Runtime {
    fn ai(&self, request: Value) -> Result<Value, String> {
        self.ai_request(request)
    }

    fn render(&self, project: &Value, id: &str, graph: &Value, path: &Path) -> Result<(), String> {
        let started = Instant::now();
        let result = self.renderer.request(&self.engine_path()?, &[], &self.root,
            &json!({"command":"render_candidate","project":project,"trackId":id,"graph":graph,"path":path}));
        self.log(format!("AI 音频渲染 {} · {:.2} 秒", if result.is_ok() { "完成" } else { "失败" }, started.elapsed().as_secs_f64()));
        result.map(|_| ())
    }

    fn apply(&self, id: &str, graph: &Value) -> Result<Value, String> {
        let _state = self.processing.lock().map_err(|_| "处理状态不可用")?;
        if self.is_cancelled() {
            return Err("处理已中止".into());
        }
        self.engine.request(
            &self.engine_path()?,
            &[],
            &self.root,
            &if id == "master" { json!({"command":"set_master","graph":graph}) }
             else { json!({"command":"set_track","id":id,"graph":graph}) },
        )
    }

    fn progress(&self, progress: processor::Progress) {
        self.log(format!(
            "AI · {} · {} · {}/{}",
            progress.label, progress.phase, progress.round, progress.rounds
        ));
        if let Ok(mut state) = self.processing.lock() {
            *state = progress;
        }
    }

    fn is_cancelled(&self) -> bool {
        self.closing.load(Ordering::Acquire) || self.cancel_requested.load(Ordering::Acquire)
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn project_root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ORVO_PROJECT_DIR") {
        return check_root(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        for parent in executable.ancestors().skip(1) {
            if parent.join("python/service.py").is_file() {
                return check_root(parent.to_owned());
            }
        }
    }
    check_root(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned(),
    )
}

fn check_root(path: PathBuf) -> Result<PathBuf, String> {
    if path.join("python/service.py").is_file() {
        Ok(path)
    } else {
        Err("找不到 orvo 应用资源目录".into())
    }
}

fn native_import(paths: &Value) -> bool {
    paths.as_array().is_some_and(|paths| {
        paths.iter().all(|value| {
            let Some(path) = value.as_str().map(Path::new) else {
                return false;
            };
            // Match the native extensions in Python's prepare_import.
            path.is_absolute()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "wav" | "wave" | "flac" | "mp3" | "ogg" | "aif" | "aiff"
                        )
                    })
        })
    })
}
