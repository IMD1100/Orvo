use crate::{
    processor::{self, Backend, Progress, Request},
    runtime::Runtime,
    worker::WorkerLane,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

struct OfflineBackend {
    runtime: Runtime,
    mock_api_service: WorkerLane,
    mock_script: PathBuf,
    python: PathBuf,
}

impl Backend for OfflineBackend {
    fn ai(&self, mut request: Value) -> Result<Value, String> {
        if matches!(request["command"].as_str(), Some("plan" | "critique")) {
            request["apiKey"] = json!("stage2-test-only-key");
            request["baseUrl"] = json!("https://unused.invalid");
            request["model"] = json!("mock");
        }
        self.mock_api_service.request(
            &self.python,
            &["-u".into(), self.mock_script.to_string_lossy().into_owned()],
            &self.runtime.root,
            &request,
        )
    }

    fn render(&self, project: &Value, id: &str, graph: &Value, path: &Path) -> Result<(), String> {
        self.runtime.render(project, id, graph, path)
    }

    fn apply(&self, id: &str, graph: &Value) -> Result<Value, String> {
        self.runtime.apply(id, graph)
    }

    fn progress(&self, progress: Progress) {
        self.runtime.progress(progress);
    }
    fn is_cancelled(&self) -> bool {
        self.runtime.is_cancelled()
    }
}

fn write_signal(path: &Path) {
    let rate = 44100_u32;
    let data_bytes = rate * 2;
    let mut wav = b"RIFF".to_vec();
    wav.extend((36 + data_bytes).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16_u32.to_le_bytes());
    wav.extend(1_u16.to_le_bytes());
    wav.extend(1_u16.to_le_bytes());
    wav.extend(rate.to_le_bytes());
    wav.extend((rate * 2).to_le_bytes());
    wav.extend(2_u16.to_le_bytes());
    wav.extend(16_u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend(data_bytes.to_le_bytes());
    for frame in 0..rate {
        let sample = (0.2
            * i16::MAX as f64
            * (std::f64::consts::TAU * 1000.0 * frame as f64 / rate as f64).sin())
            as i16;
        wav.extend(sample.to_le_bytes());
    }
    std::fs::write(path, wav).unwrap();
}

#[test]
fn loop_selection_round_trips_through_project_file() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let runtime = Runtime::new(root.to_owned());
    let folder = tempfile::tempdir().unwrap();
    let audio = folder.path().join("source.wav");
    write_signal(&audio);
    runtime.engine_request(&json!({"command":"import","paths":[audio]})).unwrap();
    let selection = json!({"start":100.0,"end":400.0,"enabled":true});
    let project = runtime.engine_request(&json!({"command":"set_loop","start":100,"end":400,"enabled":true})).unwrap();
    assert_eq!(project["loop"], selection);
    assert!(runtime.engine_request(&json!({"command":"set_loop","start":400,"end":410,"enabled":true})).is_err());
    assert_eq!(runtime.engine_request(&json!({"command":"project"})).unwrap()["loop"], selection);
    let path = folder.path().join("loop.sona.json");
    crate::project::save(&path, project).unwrap();
    let reopened = crate::project::read(&path).unwrap();
    let restored = runtime.engine_request(&json!({"command":"load_project","project":reopened})).unwrap();
    assert_eq!(restored["loop"], selection);
    runtime.shutdown();
}

#[test]
fn imports_append_clips_to_selected_track() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let runtime = Runtime::new(root.to_owned());
    let engine = |request: Value| runtime.engine_request(&request);
    let folder = tempfile::tempdir().unwrap();
    let first = folder.path().join("first.wav");
    let second = folder.path().join("second.wav");
    write_signal(&first);
    write_signal(&second);

    let blank = engine(json!({"command":"add_track"})).unwrap();
    let id = blank["tracks"][0]["id"].clone();
    assert_eq!(blank["tracks"][0]["source"], Value::Null);
    assert_eq!(
        blank["tracks"][0]["waveform"],
        json!({"duration":0.0,"peaks":[]})
    );
    assert_eq!(blank["tracks"][0]["duration"], 0.0);
    let echo = json!({
        "schema_version":3,
        "chain":[{"id":"echo","effect":"delay","enabled":true,
                  "parameters":{"delay_seconds":0.05,"feedback":0.4,"mix_ratio":0.5}}],
        "routing":{"mixers":[],"positions":{},"links":[
            {"source":"@input","target":"echo","gain_db":0},
            {"source":"echo","target":"@output","gain_db":0}
        ]}
    });
    engine(json!({"command":"set_track","id":id,"graph":echo,"gainDb":-4,"pan":0.5,"solo":true}))
        .unwrap();
    let before = engine(json!({"command":"set_master","graph":echo})).unwrap();
    engine(json!({"command":"set_spectrum","source":id})).unwrap();
    engine(json!({"command":"play"})).unwrap();
    let state = engine(json!({"command":"state"})).unwrap();
    assert_eq!(state["duration"], 0.0);
    assert_eq!(state["playing"], false);
    engine(json!({"command":"seek","position":0})).unwrap();
    let export = folder.path().join("export.wav");
    assert!(engine(json!({"command":"export","path":export})).is_err());
    assert!(engine(json!({"command":"export_track","id":id,"path":export})).is_err());
    assert!(!export.exists());
    let context = serde_json::from_value(json!({
        "instruction":"reduce echo","reference":null,"rounds":0,"availableEffects":["gain"]
    }))
    .unwrap();
    assert!(runtime
        .save_track_result(folder.path(), id.as_str().unwrap(), context)
        .is_err());

    let saved = folder.path().join("session.sona.json");
    crate::project::save(&saved, before).unwrap();
    let reopened = crate::project::read(&saved).unwrap();
    let reopened = engine(json!({"command":"load_project","project":reopened})).unwrap();
    assert_eq!(reopened["tracks"][0]["source"], Value::Null);
    assert_eq!(reopened["tracks"][0]["graph"], echo);

    let bad = folder.path().join("undecodable.wav");
    std::fs::write(&bad, b"invalid audio").unwrap();
    assert!(engine(json!({"command":"import","trackId":id,"paths":[first,bad]})).is_err());
    assert!(engine(json!({"command":"import","trackId":"unknown","paths":[first]})).is_err());
    assert_eq!(engine(json!({"command":"project"})).unwrap(), reopened);

    let other = engine(json!({"command":"add_track"})).unwrap()["tracks"][1]["id"].clone();
    let filled = engine(json!({"command":"import","trackId":id,"paths":[first,second]})).unwrap();
    let tracks = filled["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0]["id"], id);
    assert_eq!(tracks[0]["label"], "first");
    assert_eq!(tracks[0]["graph"], echo);
    assert_eq!(tracks[0]["gainDb"], -4);
    assert_eq!(tracks[0]["pan"], 0.5);
    assert_eq!(tracks[0]["solo"], true);
    assert_eq!(tracks[0]["clips"].as_array().unwrap().len(), 2);
    assert_eq!(tracks[0]["clips"][0]["start"], 0.0);
    assert_eq!(tracks[0]["clips"][1]["start"], 1000.0);
    assert_eq!(tracks[1]["id"], other);

    let inserted = engine(json!({"command":"import","trackId":id,"paths":[second]})).unwrap();
    assert_eq!(inserted["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(inserted["tracks"][0]["clips"].as_array().unwrap().len(), 3);
    assert_eq!(inserted["tracks"][0]["clips"][2]["start"], 2000.0);
    assert_eq!(inserted["tracks"][1], tracks[1]);

    engine(json!({"command":"set_track","id":id,"solo":false})).unwrap();
    engine(json!({"command":"export","path":export})).unwrap();
    let mixed = std::fs::read(&export).unwrap();
    engine(json!({"command":"set_track","id":other,"solo":true,"graph":echo})).unwrap();
    engine(json!({"command":"export","path":export})).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), mixed);
}

#[test]
fn multi_clip_analysis_uses_the_complete_timeline() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let runtime = Runtime::new(root.to_owned());
    let folder = tempfile::tempdir().unwrap();
    let first = folder.path().join("first.wav");
    let second = folder.path().join("second.wav");
    write_signal(&first); write_signal(&second);
    let id = runtime.engine_request(&json!({"command":"add_track"})).unwrap()["tracks"][0]["id"].as_str().unwrap().to_owned();
    runtime.engine_request(&json!({"command":"import","trackId":id,"paths":[first,second]})).unwrap();
    let features = runtime.analyze_track(&id).unwrap();
    assert_eq!(features["duration_seconds"], 2.0);
    runtime.shutdown();
}

#[test]
fn real_native_candidates_and_python_measurements_with_mock_api() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let folder = tempfile::tempdir().unwrap();
    let script = folder.path().join("mock_service.py");
    std::fs::write(&script, format!("import sys\nsys.path.insert(0, {})\n{}", json!(root.join("python")), r#"
import json
import service
import api_client

def fake_tool(payload, function, validator, base_url, api_key=None):
    assert api_key == 'stage2-test-only-key'
    if function == 'apply_effect_chain':
        data = {'schema_version':3,'description':'mock boost',
                'chain':[{'id':'gain_1','effect':'gain','enabled':True,'parameters':{'gain_db':18}},
                         {'id':'shift','effect':'pitch_shift','enabled':True,'parameters':{'semitones':12}}],
                'routing':{'mixers':[],'links':[{'source':'@input','target':'gain_1','gain_db':0},
                                               {'source':'gain_1','target':'shift','gain_db':0},
                                               {'source':'shift','target':'@output','gain_db':0}],'positions':{}}}
    else:
        assert function == 'revise_parameters'
        context = json.loads(payload['messages'][1]['content'])
        peak = context['output_measurements']['metrics']['sample_peak_dbfs']
        if context['plan']['chain'][0]['parameters']['gain_db'] > 6:
            assert peak > 3, peak
            data = {'action':'patch','reason':'reduce measured overload',
                    'updates':[{'id':'gain_1','parameters':{'gain_db':6}}]}
        else:
            assert peak < -6, peak
            data = {'action':'no_change','reason':'headroom verified','updates':[]}
    return validator(data), {}

api_client._request_tool = fake_tool
service.main()
"#)).unwrap();
    let source_a = folder.path().join("第一轨.wav");
    let source_b = folder.path().join("第二轨.wav");
    write_signal(&source_a);
    write_signal(&source_b);
    let source_bytes = std::fs::read(&source_a).unwrap();
    let backend = OfflineBackend {
        runtime: Runtime::new(root.clone()),
        mock_api_service: WorkerLane::default(),
        mock_script: script,
        python: root.join(if cfg!(windows) {
            "python/.venv/Scripts/python.exe"
        } else {
            "python/.venv/bin/python"
        }),
    };
    let project = backend
        .runtime
        .engine_request(&json!({"command":"import","paths":[source_a,source_b]}))
        .unwrap();
    let ids = project["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|track| track["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let candidate_folder = tempfile::tempdir_in(folder.path()).unwrap();
    let candidate_path = candidate_folder.path().to_owned();
    let result = processor::run(
        &backend,
        project,
        Request {
            track_ids: ids.clone(),
            instruction: "keep headroom".into(),
            reference: None,
            rounds: 3,
            available_effects: vec!["gain".into(), "pitch_shift".into()],
        },
        &candidate_path,
    )
    .unwrap();
    for (index, item) in result["items"].as_array().unwrap().iter().enumerate() {
        assert_eq!(item["status"], "complete", "{item}");
        assert_eq!(item["rounds"], 2, "{item}");
        assert_eq!(item["stopReason"], "no_change", "{item}");
        assert_eq!(
            result["project"]["tracks"][index]["graph"]["chain"][0]["parameters"]["gain_db"],
            6
        );
    }
    assert!(backend
        .runtime
        .engine_request(&json!({"command":"set_track","id":ids[0],"gainDb":4}))
        .is_err());
    assert_eq!(
        backend
            .runtime
            .engine_request(&json!({"command":"project"}))
            .unwrap(),
        result["project"]
    );
    let exported = folder.path().join("selected.wav");
    backend
        .runtime
        .engine_request(&json!({"command":"export_track","id":ids[0],"path":exported}))
        .unwrap();
    let report = backend.ai(json!({"command":"measure","rendered":exported,"graph":result["project"]["tracks"][0]["graph"]})).unwrap();
    let peak = report["quality"]["metrics"]["sample_peak_dbfs"]
        .as_f64()
        .unwrap();
    // Spectral transposition can change the peak while preserving the tone.
    assert!((-9.0..-6.0).contains(&peak), "{peak}");
    let audio = backend
        .ai(json!({"command":"analyze","source":exported}))
        .unwrap();
    assert_eq!(audio["duration_seconds"], 1.0);
    let centroid = audio["spectral_centroid_hz"].as_f64().unwrap();
    assert!((1950.0..2050.0).contains(&centroid), "{centroid}");
    let context = serde_json::from_value(json!({
        "instruction":"raise one octave", "reference":source_b,
        "rounds":1,"availableEffects":["gain","pitch_shift"]
    }))
    .unwrap();
    let bundle = backend
        .runtime
        .save_track_result(folder.path(), &ids[0], context)
        .unwrap();
    let reopened = crate::project::read(&bundle.join("result.sona.json")).unwrap();
    assert_eq!(reopened["ai"]["instruction"], "raise one octave");
    assert_eq!(
        reopened["tracks"][0]["graph"],
        result["project"]["tracks"][0]["graph"]
    );
    assert_eq!(
        std::fs::read(bundle.join("processed.wav")).unwrap(),
        std::fs::read(exported).unwrap()
    );
    assert_eq!(
        std::fs::read(reopened["tracks"][0]["source"].as_str().unwrap()).unwrap(),
        source_bytes
    );
    assert!(bundle.join("chain.json").is_file());
    assert_eq!(std::fs::read(&source_a).unwrap(), source_bytes);
    drop(candidate_folder);
    assert!(!candidate_path.exists());
}
