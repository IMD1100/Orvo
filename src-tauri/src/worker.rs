use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

type ChildHandle = Arc<Mutex<Child>>;

struct Worker {
    child: ChildHandle,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
}

impl Worker {
    fn start(executable: &Path, args: &[String], directory: &Path) -> Result<Self, String> {
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("无法启动服务。{e}"))?;
        let input = child.stdin.take().ok_or("服务输入不可用")?;
        let output = child.stdout.take().ok_or("服务输出不可用")?;
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let reply = serde_json::from_str(&line)
                            .map_err(|_| "后台服务返回了无效数据".to_owned());
                        let failed = reply.is_err();
                        if sender.send(reply).is_err() || failed {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            input,
            responses,
        })
    }

    fn exchange(&mut self, request: &Value) -> Result<Value, String> {
        let mut encoded = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        self.input
            .write_all(&encoded)
            .map_err(|_| "服务已退出，请重启应用".to_owned())?;
        self.input
            .flush()
            .map_err(|_| "无法发送服务请求".to_owned())?;
        let timeout = match request["command"].as_str() {
            Some("state" | "project" | "catalog") => 15,
            _ => 600,
        };
        self.responses
            .recv_timeout(Duration::from_secs(timeout))
            .map_err(|_| "后台服务未完成请求。请重启应用后重试".to_owned())?
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct WorkerLane {
    worker: Mutex<Option<Worker>>,
    child: Mutex<Option<ChildHandle>>,
    closed: AtomicBool,
}

impl WorkerLane {
    pub fn request(
        &self,
        executable: &Path,
        args: &[String],
        directory: &Path,
        request: &Value,
    ) -> Result<Value, String> {
        let mut slot = self.worker.lock().map_err(|_| "服务状态不可用")?;
        if self.closed.load(Ordering::Acquire) {
            return Err("应用正在关闭".to_owned());
        }
        if slot.is_none() {
            let worker = Worker::start(executable, args, directory)?;
            let mut child = self.child.lock().map_err(|_| "服务状态不可用")?;
            if self.closed.load(Ordering::Acquire) {
                return Err("应用正在关闭".to_owned());
            }
            *child = Some(worker.child.clone());
            *slot = Some(worker);
        }
        let reply = match slot.as_mut().unwrap().exchange(request) {
            Ok(reply) => reply,
            Err(error) => {
                self.closed.store(true, Ordering::Release);
                *slot = None;
                return Err(error);
            }
        };
        if reply["ok"] == true {
            Ok(reply["data"].clone())
        } else {
            Err(reply["error"].as_str().unwrap_or("后台处理失败").to_owned())
        }
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(slot) = self.child.lock() {
            if let Some(handle) = slot.as_ref() {
                if let Ok(mut child) = handle.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn shutdown_interrupts_a_pending_request() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let python = root.join(if cfg!(windows) {
            "python/.venv/Scripts/python.exe"
        } else {
            "python/.venv/bin/python"
        });
        assert!(
            python.is_file(),
            "Create the project Python environment first"
        );
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("waiting_service.py");
        std::fs::write(
            &script,
            "import sys,time\nfor line in sys.stdin:\n time.sleep(30)\n",
        )
        .unwrap();
        let lane = Arc::new(WorkerLane::default());
        let requester = lane.clone();
        let directory = folder.path().to_owned();
        let thread = std::thread::spawn(move || {
            requester.request(
                &python,
                &["-u".into(), script.to_string_lossy().into_owned()],
                &directory,
                &serde_json::json!({"command":"pending"}),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while lane.child.lock().unwrap().is_none() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let closing = Instant::now();
        lane.shutdown();
        assert!(thread.join().unwrap().is_err());
        assert!(closing.elapsed() < Duration::from_secs(3));
    }
}
