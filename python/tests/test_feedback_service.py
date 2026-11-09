import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service
import api_client
from test_service import Response, graph


class FeedbackServiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = str(Path(self.folder.name) / "source.wav")
        self.hot = str(Path(self.folder.name) / "hot.wav")
        samples = np.sin(2 * np.pi * 440 * np.arange(48000 * 4) / 48000)
        sf.write(self.source, samples * 0.25, 48000, subtype="FLOAT")
        sf.write(self.hot, samples * 1.3 + 0.025, 48000, subtype="FLOAT")

    def measure(self, path):
        response = service.respond({"command": "measure", "rendered": path, "graph": graph()})
        self.assertTrue(response["ok"], response)
        return response["data"]

    def request(self):
        return {"command": "critique", "source": self.source, "reference": self.hot,
                "instruction": "保持自然", "graph": graph(), "measurement": self.measure(self.hot),
                "baseUrl": "https://example.invalid/v1", "model": "mock-model", "apiKey": "test-new-key"}

    def test_real_float_measurement_and_technical_comparison(self):
        normal, hot = self.measure(self.source), self.measure(self.hot)
        quality = hot["quality"]
        self.assertEqual(set(hot), {"quality", "detector"})
        self.assertEqual(quality["scope"]["frames"], 48000 * 4)
        self.assertAlmostEqual(quality["metrics"]["sample_peak_dbfs"], 20 * np.log10(1.325), places=3)
        self.assertAlmostEqual(quality["metrics"]["dc_offset"], 0.025, places=6)
        self.assertEqual(quality["meter"]["status"], "measured")
        self.assertGreater(quality["metrics"]["true_peak_dbtp"], 0)
        self.assertNotIn("calibration", quality["meter"])
        self.assertEqual(quality["targets"], {})
        self.assertTrue(any(issue["category"] == "true_peak_over" for issue in hot["detector"]["issues"]))
        for before, after, accepted in ((normal, hot, False), (hot, normal, True), (normal, normal, True)):
            response = service.respond({"command": "compare", "before": before, "after": after})
            self.assertTrue(response["ok"], response)
            self.assertEqual(response["data"]["accepted"], accepted)

    def test_mock_critic_explicit_key_full_statistics_and_unchanged_topology(self):
        request = self.request()
        decision = {"action": "patch", "reason": "降低超限", "updates": [{"id": "gain1", "parameters": {"gain_db": -4}}]}
        original = copy.deepcopy(request)
        with patch.object(api_client.requests, "Session") as factory, patch.object(api_client, "load_api_key", side_effect=AssertionError("old key read")):
            factory.return_value.post.return_value = Response("revise_parameters", decision)
            response = service.respond(request)
            self.assertTrue(response["ok"], response)
            call = factory.return_value.post.call_args.kwargs
            self.assertEqual(call["headers"]["Authorization"], "Bearer test-new-key")
            context = json.loads(call["json"]["messages"][1]["content"])
            self.assertEqual(context["input_audio_statistics"]["analyzed_seconds"], 4)
            self.assertEqual(context["reference_audio_statistics"]["analyzed_seconds"], 4)
            self.assertEqual(context["targets"], {})
            self.assertNotIn(request["apiKey"], json.dumps(call["json"]))
        expected = graph()
        expected["chain"][0]["parameters"]["gain_db"] = -4
        self.assertEqual(response["data"], {"decision": decision, "graph": expected})
        self.assertEqual(request, original)

    def test_invalid_critic_revisions_and_secret_are_rejected(self):
        request = self.request()
        decisions = [
            {"action": "patch", "reason": "x", "updates": [{"id": "gain1", "parameters": {"gain_db": value}}]}
            for value in (True, 999, float("nan"), float("inf"))
        ]
        decisions += [
            {"action": "patch", "reason": "x", "updates": [{"id": "new", "parameters": {"gain_db": 0}}]},
            {"action": "patch", "reason": "x", "updates": [{"id": "gain1", "enabled": False, "parameters": {"gain_db": 0}}]},
            {"action": "patch", "reason": "x", "updates": [{"id": "gain1", "parameters": {"new": 0}}]},
            {"action": "no_change", "reason": "x", "updates": [], "routing": {}},
            {"action": "no_change", "reason": request["apiKey"], "updates": []},
        ]
        for decision in decisions:
            with self.subTest(decision=decision), patch.object(api_client.requests, "Session") as factory:
                factory.return_value.post.return_value = Response("revise_parameters", decision)
                result = service.respond(request)
                self.assertFalse(result["ok"], result)
                self.assertNotIn(request["apiKey"], json.dumps(result))

    def test_invalid_graph_measurement_and_request_fields_are_rejected_before_api(self):
        request = self.request()
        invalid = []
        for mutate in (
            lambda r: r["graph"]["chain"][0].pop("enabled"),
            lambda r: r["graph"]["routing"].update({"unknown": []}),
            lambda r: r["measurement"]["quality"]["metrics"].update({"dc_offset": float("nan")}),
            lambda r: r["measurement"].update({"unknown": {}}),
            lambda r: r.update({"apiKey": ""}),
            lambda r: r.update({"rendered": self.hot}),
        ):
            case = copy.deepcopy(request)
            mutate(case)
            invalid.append(case)
        with patch.object(api_client.requests, "Session", side_effect=AssertionError("must reject before API")):
            for case in invalid:
                self.assertFalse(service.respond(case)["ok"])
        invalid_report = copy.deepcopy(request["measurement"])
        invalid_report["quality"]["metrics"]["dc_offset"] = "invalid"
        self.assertFalse(service.respond({"command": "compare", "before": invalid_report, "after": request["measurement"]})["ok"])

    def test_jsonl_measure_compare_and_nonfinite_continuation(self):
        measurement = self.measure(self.source)
        lines = ['{"command":"compare","before":NaN}',
                 json.dumps({"command": "measure", "rendered": self.hot, "graph": graph()}),
                 json.dumps({"command": "compare", "before": measurement, "after": measurement})]
        process = subprocess.run([sys.executable, "-u", service.__file__], input="\n".join(lines) + "\n",
                                 text=True, encoding="utf-8", capture_output=True, check=True)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([reply["ok"] for reply in replies], [False, True, True])
        self.assertEqual(replies[2]["data"], {"accepted": True, "reason": "checks_passed"})
        self.assertEqual(process.stderr, "")


if __name__ == "__main__":
    unittest.main()
