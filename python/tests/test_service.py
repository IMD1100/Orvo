import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf
import imageio_ffmpeg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service
import api_client


def graph():
    return {
        "schema_version": 3, "description": "保持原声", "chain": [
            {"id": "gain1", "effect": "gain", "enabled": True, "parameters": {"gain_db": 0}}
        ],
        "routing": {"mixers": [], "links": [
            {"source": "@input", "target": "gain1", "gain_db": 0},
            {"source": "gain1", "target": "@output", "gain_db": 0},
        ], "positions": {}},
    }


class Response:
    ok = True

    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments

    def json(self):
        return {"choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [
            {"function": {"name": self.name, "arguments": json.dumps(self.arguments)}}
        ]}}]}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.audio = str(Path(self.folder.name) / "whole.wav")
        # Silence in the first full block and signal only later catches preview-only analysis.
        samples = np.zeros(44100 * 4, dtype=np.float32)
        samples[131072:] = 0.25
        sf.write(self.audio, samples, 44100, subtype="FLOAT")
        self.samples = samples
        self.request = {"command": "plan", "source": self.audio, "instruction": "保持自然",
                        "reference": None, "baseUrl": "https://example.invalid/v1", "model": "mock-model",
                        "apiKey": "synthetic-test-credential", "currentGraph": None, "availableEffects": ["gain"]}

    def test_features_reused_and_invalidated_when_audio_changes(self):
        service._cached_features.cache_clear()
        with patch.object(service, "audio_features", wraps=service.audio_features) as analyze:
            first = service.features(self.audio)
            again = service.features(self.audio)
            self.assertEqual(first, again)
            self.assertEqual(analyze.call_count, 1)
            sf.write(self.audio, np.ones(44100, dtype=np.float32) * 0.1, 44100, subtype="FLOAT")
            updated = service.features(self.audio)
            self.assertEqual(analyze.call_count, 2)
            self.assertEqual(updated["analyzed_seconds"], 1)

    def test_complete_audio_features_and_protocol(self):
        result = service.respond({"command": "analyze", "source": self.audio})
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["analyzed_seconds"], 4)
        self.assertAlmostEqual(result["data"]["rms_dbfs"], 20 * np.log10(np.sqrt(np.mean(self.samples ** 2))), places=2)
        process = subprocess.run([sys.executable, "-u", str(Path(service.__file__))],
                                 input="invalid\n" + json.dumps({"command": "analyze", "source": self.audio}) + "\n",
                                 text=True, encoding="utf-8", capture_output=True, check=True)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertFalse(replies[0]["ok"])
        self.assertTrue(replies[1]["ok"])
        self.assertEqual(process.stderr, "")

    def test_exact_parameters_and_routing(self):
        mutations = []
        for value in (True, float("nan"), float("inf"), 100):
            invalid = graph()
            invalid["chain"][0]["parameters"]["gain_db"] = value
            mutations.append(invalid)
        for parameters in ({}, {"gain_db": 0, "unknown": 1}):
            invalid = graph()
            invalid["chain"][0]["parameters"] = parameters
            mutations.append(invalid)
        invalid = graph()
        invalid["chain"][0]["pluginPath"] = "unexpected"
        mutations.append(invalid)
        invalid = graph()
        invalid["routing"]["links"].append({"source": "gain1", "target": "gain1", "gain_db": 0})
        mutations.append(invalid)
        invalid = graph()
        invalid["routing"]["links"].pop()
        mutations.append(invalid)
        for invalid in mutations:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                service.validate_graph(invalid, ["gain"], model_output=True)
        self.assertEqual(service.validate_graph(graph(), ["gain"], model_output=True), graph())

    def test_prepare_import_real_m4a_and_cleanup(self):
        compressed = str(Path(self.folder.name) / "原始名字.m4a")
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", self.audio, "-c:a", "aac", compressed], check=True, capture_output=True)
        process = subprocess.Popen([sys.executable, "-u", str(Path(service.__file__))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8")
        try:
            process.stdin.write(json.dumps({"command": "prepare_import", "paths": [self.audio, compressed]}) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            self.assertTrue(response["ok"], response)
            original, decoded = response["data"]["paths"]
            self.assertEqual(original, self.audio)
            decoded_path = Path(decoded)
            self.assertEqual(decoded_path.stem, Path(compressed).stem)
            samples, sample_rate = sf.read(decoded)
            self.assertEqual(sample_rate, 44100)
            self.assertAlmostEqual(len(samples) / sample_rate, 4, delta=0.05)
            self.assertTrue(np.isfinite(samples).all())
            process.stdin.write(json.dumps({"command": "prepare_import", "paths": [str(Path(service.__file__))]}) + "\n")
            process.stdin.flush()
            self.assertFalse(json.loads(process.stdout.readline())["ok"])
            _, errors = process.communicate(timeout=10)
            self.assertEqual(errors, "")
            self.assertEqual(process.returncode, 0)
            self.assertFalse(decoded_path.exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_mock_plan_retry_schema_key_and_no_disk_fallback(self):
        invalid = graph()
        invalid["chain"][0]["parameters"]["gain_db"] = 99
        previous_environment = dict(os.environ)
        with patch.object(api_client.requests, "Session") as factory, patch.object(api_client, "load_api_key", side_effect=AssertionError("must not read saved key")):
            session = factory.return_value
            session.post.side_effect = [Response("apply_effect_chain", invalid), Response("apply_effect_chain", graph())]
            result = service.respond(self.request)
            self.assertEqual(result, {"ok": True, "data": graph()})
            self.assertEqual(session.post.call_count, 2)
            call = session.post.call_args
            self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer " + self.request["apiKey"])
            payload = call.kwargs["json"]
            schema = payload["tools"][0]["function"]["parameters"]
            self.assertEqual(schema["properties"]["schema_version"]["enum"], [3])
            gain = schema["properties"]["chain"]["items"]["oneOf"][0]
            self.assertFalse(gain["properties"]["parameters"]["additionalProperties"])
            self.assertNotIn(self.request["apiKey"], json.dumps(payload))
        self.assertEqual(dict(os.environ), previous_environment)

    def test_secret_never_in_output_or_diagnostics(self):
        leaking = graph()
        leaking["description"] = self.request["apiKey"]
        with patch.object(api_client.requests, "Session") as factory:
            factory.return_value.post.return_value = Response("apply_effect_chain", leaking)
            result = service.respond(self.request)
        self.assertFalse(result["ok"])
        self.assertNotIn(self.request["apiKey"], json.dumps(result))
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(service, "dispatch", side_effect=ValueError("bad " + self.request["apiKey"])), patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            result = service.respond(self.request)
        self.assertNotIn(self.request["apiKey"], json.dumps(result) + stdout.getvalue() + stderr.getvalue())
        with patch.object(api_client.requests, "Session") as factory:
            factory.return_value.post.side_effect = api_client.requests.ConnectionError(self.request["apiKey"])
            with patch("time.sleep"):
                result = service.respond(self.request)
        self.assertFalse(result["ok"])
        self.assertNotIn(self.request["apiKey"], json.dumps(result))

    def test_optimize_only_sound_goals(self):
        request = {**self.request, "command": "optimize", "referenceProvided": True,
                   "batchFileCount": 2, "availableEffects": ["pitch_shift"]}
        with patch.object(api_client.requests, "Session") as factory:
            factory.return_value.post.return_value = Response("rewrite_audio_instruction", {"instruction": "声音自然，保留细节。"})
            result = service.respond(request)
            system = factory.return_value.post.call_args.kwargs["json"]["messages"][0]["content"]
            self.assertIn("不推荐效果器", system)
            context = json.loads(factory.return_value.post.call_args.kwargs["json"]["messages"][1]["content"])
            self.assertEqual(context["available_effects"], ["pitch_shift"])
            self.assertTrue(context["reference_provided"])
            self.assertEqual(context["batch_file_count"], 2)
        self.assertEqual(result, {"ok": True, "data": {"instruction": "声音自然，保留细节。"}})

    def test_catalog_and_disallowed_effect(self):
        result = service.respond({"command": "catalog"})["data"]
        self.assertEqual(set(result["catalog"]), set(result["labels"]))
        self.assertIn("default", result["catalog"]["gain"]["parameters"]["gain_db"])
        with self.assertRaises(ValueError):
            service.validate_graph(graph(), ["limiter"], model_output=True)

    def test_legacy_pitch_plan_import_preserves_parameters_and_routing(self):
        legacy = {"schema_version": 2, "chain": [
            {"effect": "pitch_shift", "parameters": {"semitones": -12}}
        ]}
        response = service.respond({"command": "normalize_graph", "graph": legacy})
        self.assertTrue(response["ok"], response)
        plan = response["data"]
        self.assertEqual(plan["schema_version"], 3)
        self.assertEqual(plan["chain"][0]["parameters"]["semitones"], -12)
        self.assertEqual(plan["routing"]["links"][0]["target"], plan["chain"][0]["id"])
        self.assertEqual(service.respond({"command": "normalize_graph", "graph": plan}), response)
        legacy["chain"][0]["parameters"]["semitones"] = 25
        self.assertFalse(service.respond({"command": "normalize_graph", "graph": legacy})["ok"])


if __name__ == "__main__":
    unittest.main()
