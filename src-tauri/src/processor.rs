use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub track_ids: Vec<String>,
    pub instruction: String,
    pub reference: Option<String>,
    pub rounds: u8,
    pub available_effects: Vec<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub active: bool,
    pub total: usize,
    pub completed: usize,
    pub track_id: String,
    pub label: String,
    pub phase: &'static str,
    pub round: u8,
    pub rounds: u8,
}

pub trait Backend {
    fn ai(&self, request: Value) -> Result<Value, String>;
    fn render(&self, project: &Value, id: &str, graph: &Value, path: &Path) -> Result<(), String>;
    fn apply(&self, id: &str, graph: &Value) -> Result<Value, String>;
    fn progress(&self, progress: Progress);
    fn is_cancelled(&self) -> bool;
}

fn check_running(backend: &impl Backend) -> Result<(), String> {
    if backend.is_cancelled() {
        Err("处理已中止".into())
    } else {
        Ok(())
    }
}

impl Progress {
    fn stage(
        &mut self,
        backend: &impl Backend,
        phase: &'static str,
        round: u8,
    ) -> Result<(), String> {
        check_running(backend)?;
        self.phase = phase;
        self.round = round;
        backend.progress(self.clone());
        Ok(())
    }
}

fn patch_shape(graph: &Value) -> Option<(Value, Vec<Vec<String>>)> {
    let mut shape = graph.clone();
    let keys = shape["chain"]
        .as_array_mut()?
        .iter_mut()
        .map(|node| {
            let parameters = node.as_object_mut()?.remove("parameters")?;
            let values = parameters.as_object()?;
            values
                .values()
                .all(Value::is_number)
                .then(|| values.keys().cloned().collect())
        })
        .collect::<Option<_>>()?;
    Some((shape, keys))
}

struct TrackRun<'a, B> {
    backend: &'a B,
    project: &'a Value,
    request: &'a Request,
    track: &'a Value,
    directory: &'a Path,
    progress: Progress,
}

impl<B: Backend> TrackRun<'_, B> {
    fn measure(&mut self, graph: &Value, round: u8) -> Result<Value, String> {
        let path = self
            .directory
            .join(format!("{}-{round}.wav", self.progress.completed));
        self.progress.stage(self.backend, "rendering", round)?;
        self.backend
            .render(self.project, &self.progress.track_id, graph, &path)?;
        self.progress.stage(self.backend, "measuring", round)?;
        let result = self
            .backend
            .ai(json!({"command":"measure","rendered":path,"graph":graph}))?;
        if !result["quality"].is_object() || !result["detector"].is_object() {
            return Err("测量结果无效".into());
        }
        Ok(result)
    }

    fn execute(&mut self) -> Result<(Value, Value), String> {
        self.progress.stage(self.backend, "planning", 0)?;
        let needs_mix = self.progress.track_id == "master" || self.track["clips"].as_array().is_some_and(|clips| clips.len() > 1 || clips.first().is_some_and(|clip| clip["start"].as_f64().unwrap_or(0.0) > 0.0));
        let source = if needs_mix {
            let path = self.directory.join(format!("{}-dry.wav", self.progress.completed));
            let clean = json!({"schema_version":3,"chain":[],"routing":{"mixers":[],"positions":{},"links":[{"source":"@input","target":"@output","gain_db":0}]}});
            self.backend.render(self.project, &self.progress.track_id, &clean, &path)?;
            json!(path)
        } else { self.track["source"].clone() };
        let mut best = self.backend.ai(json!({
            "command":"plan","source":source,"currentGraph":self.track["graph"],
            "instruction":self.request.instruction,"reference":self.request.reference,
            "availableEffects":self.request.available_effects
        }))?;
        let mut measurement = self.measure(&best, 0)?;
        let mut stop_reason = if self.request.rounds == 0 {
            "disabled"
        } else {
            "round_limit"
        }
        .to_owned();
        let mut warning = None;
        let mut attempted = 0;
        for round in 1..=self.request.rounds {
            self.progress.stage(self.backend, "reviewing", round)?;
            attempted = round;
            let revision = (|| -> Result<Option<(Value, Value)>, String> {
                let response = self.backend.ai(json!({
                    "command":"critique","source":source,"instruction":self.request.instruction,
                    "reference":self.request.reference,"graph":best,"measurement":measurement
                }))?;
                match response["decision"]["action"].as_str() {
                    Some(action @ ("no_change" | "requires_replan")) => {
                        stop_reason = action.into();
                        return Ok(None);
                    }
                    Some("patch") => {}
                    _ => return Err("修订结果无效".into()),
                }
                let candidate = &response["graph"];
                let shape = patch_shape(candidate);
                if shape.is_none() || shape != patch_shape(&best) {
                    return Err("修订改变了效果器或路由结构".into());
                }
                if candidate == &best {
                    stop_reason = "unchanged_parameters".into();
                    return Ok(None);
                }
                let after = self.measure(candidate, round)?;
                self.progress.stage(self.backend, "comparing", round)?;
                let verdict = self
                    .backend
                    .ai(json!({"command":"compare","before":measurement,"after":after}))?;
                match verdict["accepted"].as_bool() {
                    Some(true) => Ok(Some((candidate.clone(), after))),
                    Some(false) => {
                        stop_reason = verdict["reason"]
                            .as_str()
                            .unwrap_or("technical_regression")
                            .into();
                        Ok(None)
                    }
                    None => Err("修订比较结果无效".into()),
                }
            })();
            match revision {
                Ok(Some((candidate, after))) => {
                    best = candidate;
                    measurement = after;
                }
                Ok(None) => break,
                Err(error) => {
                    warning = Some(error);
                    stop_reason = "feedback_error".into();
                    break;
                }
            }
        }
        self.progress.stage(self.backend, "applying", attempted)?;
        let project = self.backend.apply(&self.progress.track_id, &best)?;
        let mut item = json!({"trackId":self.progress.track_id,"label":self.progress.label,"status":"complete","rounds":attempted,"stopReason":stop_reason});
        if let Some(warning) = warning {
            item["warning"] = json!(warning);
        }
        Ok((project, item))
    }
}

pub fn run(
    backend: &impl Backend,
    mut project: Value,
    request: Request,
    directory: &Path,
) -> Result<Value, String> {
    if request.rounds > 3 {
        return Err("修订轮数应为 0–3".into());
    }
    if request.instruction.trim().is_empty() || request.instruction.chars().count() > 4000 {
        return Err("请填写不超过 4000 字的混音要求".into());
    }
    if request.available_effects.is_empty() {
        return Err("请至少选择一种效果器".into());
    }
    let tracks = project["tracks"].as_array().ok_or("工程缺少轨道")?;
    let total = request.track_ids.len();
    if total == 0
        || total > tracks.len() + 1
        || request.track_ids.iter().collect::<HashSet<_>>().len() != total
    {
        return Err("待处理轨道为空、重复或超出工程范围".into());
    }
    let selected = request
        .track_ids
        .iter()
        .map(|id| {
            if id == "master" {
                if !tracks.iter().any(|track| track["source"].is_string()) {
                    return Err("工程中没有音频素材");
                }
                let mut master = project["master"].clone();
                if !master.is_object() { return Err("工程缺少 Master 通道"); }
                master["label"] = json!("Master");
                return Ok(master);
            }
            let track = tracks
                .iter()
                .find(|track| track["id"] == id.as_str())
                .ok_or("待处理轨道已不存在")?;
            if !track["source"].is_string() {
                return Err("待处理轨道中有空音轨");
            }
            Ok(track.clone())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut items = Vec::with_capacity(total);
    for (completed, track) in selected.iter().enumerate() {
        if backend.is_cancelled() {
            break;
        }
        let mut task = TrackRun {
            backend,
            project: &project,
            request: &request,
            track,
            directory,
            progress: Progress {
                active: true,
                total,
                completed,
                track_id: request.track_ids[completed].clone(),
                label: track["label"].as_str().unwrap_or("音轨").into(),
                rounds: request.rounds,
                ..Progress::default()
            },
        };
        let result = task.execute();
        let mut status = task.progress;
        status.completed += 1;
        match result {
            Ok((updated, item)) => {
                project = updated;
                items.push(item);
                status.phase = "complete";
            }
            Err(_) if backend.is_cancelled() => break,
            Err(error) => {
                items.push(json!({"trackId":status.track_id,"label":status.label,"status":"failed","rounds":status.round,"stopReason":"failed","error":error}));
                status.phase = "failed";
            }
        }
        backend.progress(status);
    }
    Ok(json!({"project":project,"items":items,"cancelled":items.len() < total}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    fn graph(gain: f64) -> Value {
        json!({"schema_version":3,"chain":[{"id":"g","effect":"gain","enabled":true,"parameters":{"gain_db":gain}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"g","gain_db":0},{"source":"g","target":"@output","gain_db":0}],"positions":{}}})
    }

    fn project() -> Value {
        json!({"schemaVersion":1,"sampleRate":44100,"tracks":[
            {"id":"a","label":"A","source":"a.wav","gainDb":-7,"pan":0.3,"muted":true,"graph":graph(0.0)},
            {"id":"b","label":"B","source":"bad.wav","gainDb":-2,"graph":graph(0.0)},
            {"id":"c","label":"C","source":"c.wav","gainDb":-3,"graph":graph(0.0)}],"master":{"gainDb":-4,"graph":graph(0.0)}})
    }

    struct Fake {
        state: RefCell<Value>,
        calls: RefCell<Vec<String>>,
        sources: RefCell<Vec<Value>>,
        mode: &'static str,
        cancelled: Cell<bool>,
    }
    impl Fake {
        fn new(mode: &'static str) -> Self {
            Self {
                state: RefCell::new(project()),
                calls: RefCell::new(vec![]),
                sources: RefCell::new(vec![]),
                mode,
                cancelled: Cell::new(false),
            }
        }
    }
    impl Backend for Fake {
        fn ai(&self, request: Value) -> Result<Value, String> {
            let command = request["command"].as_str().unwrap();
            self.calls.borrow_mut().push(command.to_owned());
            if matches!(command, "plan" | "critique") { self.sources.borrow_mut().push(request["source"].clone()); }
            match command {
                "plan" if request["source"] == "bad.wav" => Err("one track failed".into()),
                "plan" => Ok(graph(-1.0)),
                "measure" if self.mode == "bad_measure" => Err("measurement failed".into()),
                "measure" => Ok(
                    json!({"quality":{"gain":request["graph"]["chain"][0]["parameters"]["gain_db"]},"detector":{}}),
                ),
                "critique" if self.mode == "error" => Err("critic unavailable".into()),
                "critique" if self.mode == "no_change" => Ok(
                    json!({"decision":{"action":"no_change","reason":"enough","updates":[]},"graph":request["graph"]}),
                ),
                "critique" => {
                    let mut next = request["graph"].clone();
                    let gain = if self.mode == "regression" {
                        6.0
                    } else {
                        next["chain"][0]["parameters"]["gain_db"].as_f64().unwrap() - 1.0
                    };
                    next["chain"][0]["parameters"]["gain_db"] = json!(gain);
                    if self.mode == "structure" {
                        next["routing"]["links"] = json!([]);
                    }
                    Ok(
                        json!({"decision":{"action":"patch","reason":"adjust","updates":[{"id":"g","parameters":{"gain_db":gain}}]},"graph":next}),
                    )
                }
                "compare" => {
                    let accepted = request["after"]["quality"]["gain"].as_f64().unwrap()
                        <= request["before"]["quality"]["gain"].as_f64().unwrap();
                    Ok(
                        json!({"accepted":accepted,"reason":if accepted {"checks_passed"} else {"technical_regression"}}),
                    )
                }
                _ => panic!("unexpected command"),
            }
        }
        fn render(&self, _: &Value, _: &str, _: &Value, _: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push("render".into());
            if self.mode == "cancel"
                || (self.mode == "cancel_after_first"
                    && self.calls.borrow().iter().any(|s| s == "apply"))
            {
                self.cancelled.set(true);
            }
            Ok(())
        }
        fn apply(&self, id: &str, graph: &Value) -> Result<Value, String> {
            self.calls.borrow_mut().push("apply".into());
            let mut project = self.state.borrow_mut();
            if id == "master" {
                project["master"]["graph"] = graph.clone();
                return Ok(project.clone());
            }
            let track = project["tracks"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|t| t["id"] == id)
                .unwrap();
            track["graph"] = graph.clone();
            Ok(project.clone())
        }
        fn progress(&self, _: Progress) {}
        fn is_cancelled(&self) -> bool {
            self.cancelled.get()
        }
    }

    #[test]
    fn master_uses_rendered_mix_and_applies_master_graph() {
        let backend = Fake::new("no_change");
        let folder = tempfile::tempdir().unwrap();
        let result = run(&backend, project(), request(&["master"], 1), folder.path()).unwrap();
        assert_eq!(result["items"][0]["trackId"], "master");
        assert_eq!(result["items"][0]["status"], "complete");
        assert_eq!(result["project"]["master"]["graph"], graph(-1.0));
        assert!(backend.sources.borrow().iter().all(|source| source.as_str().unwrap().ends_with("-dry.wav")));
        assert_eq!(&backend.calls.borrow()[..3], &["render", "plan", "render"]);
    }
    fn request(ids: &[&str], rounds: u8) -> Request {
        Request {
            track_ids: ids.iter().map(|id| id.to_string()).collect(),
            instruction: "clearer".into(),
            reference: None,
            rounds,
            available_effects: vec!["gain".into()],
        }
    }

    #[test]
    fn multi_clip_and_offset_tracks_use_combined_dry_audio_for_ai() {
        for clips in [
            json!([{"start":0},{"start":1500}]),
            json!([{"start":500}]),
        ] {
            let backend = Fake::new("no_change");
            let folder = tempfile::tempdir().unwrap();
            let mut data = project();
            data["tracks"][0]["clips"] = clips;
            let result = run(&backend, data, request(&["a"], 1), folder.path()).unwrap();
            assert_eq!(result["items"][0]["status"], "complete");
            assert_eq!(backend.calls.borrow()[0], "render");
            let sources = backend.sources.borrow();
            assert_eq!(sources.len(), 2);
            assert_eq!(sources[0], sources[1]);
            assert!(sources[0].as_str().unwrap().ends_with("0-dry.wav"));
        }
    }

    #[test]
    fn bounded_feedback_and_batch_failure_preserve_channel_controls() {
        let backend = Fake::new("patch");
        let folder = tempfile::tempdir().unwrap();
        let result = run(
            &backend,
            project(),
            request(&["a", "b", "c"], 3),
            folder.path(),
        )
        .unwrap();
        assert_eq!(result["items"][0]["status"], "complete");
        assert_eq!(result["items"][1]["status"], "failed");
        assert_eq!(result["items"][2]["status"], "complete");
        assert_eq!(result["project"]["tracks"][0]["graph"], graph(-4.0));
        assert_eq!(result["project"]["tracks"][0]["gainDb"], -7);
        assert_eq!(result["project"]["tracks"][0]["muted"], true);
        assert_eq!(result["project"]["tracks"][0]["pan"], 0.3);
        assert_eq!(result["project"]["tracks"][1]["graph"], graph(0.0));
        assert_eq!(
            backend
                .calls
                .borrow()
                .iter()
                .filter(|s| s.as_str() == "apply")
                .count(),
            2
        );
    }

    #[test]
    fn rejected_or_failed_feedback_keeps_the_verified_initial_graph() {
        for mode in ["regression", "error", "structure"] {
            let backend = Fake::new(mode);
            let folder = tempfile::tempdir().unwrap();
            let result = run(&backend, project(), request(&["a"], 3), folder.path()).unwrap();
            assert_eq!(result["items"][0]["status"], "complete", "{mode}");
            assert_eq!(
                result["project"]["tracks"][0]["graph"],
                graph(-1.0),
                "{mode}"
            );
            assert_eq!(
                result["items"][0]["stopReason"],
                if mode == "regression" {
                    "technical_regression"
                } else {
                    "feedback_error"
                }
            );
        }
        let backend = Fake::new("bad_measure");
        let folder = tempfile::tempdir().unwrap();
        let result = run(&backend, project(), request(&["a"], 1), folder.path()).unwrap();
        assert_eq!(result["items"][0]["status"], "failed");
        assert_eq!(result["project"], project());
    }

    #[test]
    fn no_change_zero_rounds_and_invalid_requests_do_not_spend_extra_calls() {
        for rounds in [0, 3] {
            let backend = Fake::new("no_change");
            let folder = tempfile::tempdir().unwrap();
            let result = run(&backend, project(), request(&["a"], rounds), folder.path()).unwrap();
            assert_eq!(
                result["items"][0]["stopReason"],
                if rounds == 0 { "disabled" } else { "no_change" }
            );
            assert_eq!(
                backend
                    .calls
                    .borrow()
                    .iter()
                    .filter(|s| s.as_str() == "render")
                    .count(),
                1
            );
            assert_eq!(
                backend
                    .calls
                    .borrow()
                    .iter()
                    .filter(|s| s.as_str() == "critique")
                    .count(),
                if rounds == 0 { 0 } else { 1 }
            );
        }
        let backend = Fake::new("patch");
        let folder = tempfile::tempdir().unwrap();
        for options in [
            request(&["a"], 4),
            request(&["a", "a"], 1),
            request(&["missing"], 1),
        ] {
            assert!(run(&backend, project(), options, folder.path()).is_err());
        }
        let mut with_empty = project();
        with_empty["tracks"][1]["source"] = Value::Null;
        assert!(run(&backend, with_empty, request(&["a", "b"], 1), folder.path()).is_err());
        assert!(backend.calls.borrow().is_empty());
    }

    #[test]
    fn shutdown_between_stages_prevents_commit() {
        let backend = Fake::new("cancel");
        let folder = tempfile::tempdir().unwrap();
        let result = run(&backend, project(), request(&["a", "c"], 3), folder.path()).unwrap();
        assert_eq!(result["cancelled"], true);
        assert_eq!(result["project"], project());
        assert!(!backend.calls.borrow().iter().any(|s| s == "apply"));
        let backend = Fake::new("cancel_after_first");
        let result = run(&backend, project(), request(&["a", "c"], 0), folder.path()).unwrap();
        assert_eq!(result["cancelled"], true);
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["project"]["tracks"][0]["graph"], graph(-1.0));
        assert_eq!(result["project"]["tracks"][2]["graph"], graph(0.0));
    }
}
