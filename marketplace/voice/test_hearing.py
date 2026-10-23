"""Transcription without real models: the catalog, downloads from a local server, whisper.cpp's
server played by a stand-in, and the model kept loaded or let go, with fake engines.

    uv run --no-project --with numpy python -m unittest discover -s marketplace/voice
"""

import hashlib
import http.server
import json
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path

import numpy as np

import catalog
import machine
from catalog import File, Model
from downloads import Downloads
from engines import EngineError, WhisperCpp
from hearing import Config, Ears, Runtimes

SPEECH = np.full(16000, 0.5, dtype=np.float32)


class Site:
    """A local web server for files, answering ranges as Hugging Face does."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.asked: list[str] = []
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                site.asked.append(self.headers.get("Range") or "all")
                data = site.files.get(self.path.lstrip("/"))
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                start = 0
                if self.headers.get("Range"):
                    start = int(self.headers["Range"].split("=")[1].split("-")[0])
                    self.send_response(206)
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(data) - start))
                self.end_headers()
                self.wfile.write(data[start:])

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def file(self, name: str, sha: str | None = None) -> File:
        data = self.files[name]
        return File(name, f"http://127.0.0.1:{self.server.server_port}/{name}", len(data),
                    sha or hashlib.sha256(data).hexdigest())

    def close(self):
        self.server.shutdown()


class Catalog(unittest.TestCase):
    def test_every_model_is_pinned_and_runs_on_an_engine_voice_has(self):
        engines = {engine.id for engine in catalog.ENGINES}
        ids = [model.id for model in catalog.MODELS]
        self.assertEqual(len(ids), len(set(ids)))
        for model in catalog.MODELS:
            self.assertIn(model.engine, engines)
            self.assertTrue(model.id.startswith(model.engine + "/"))
            for file in model.files:
                self.assertRegex(file.sha256, "^[0-9a-f]{64}$", file.name)
                self.assertGreater(file.size, 0)
                self.assertNotIn("/main/", file.url, "pinned to a revision")
        for engine in engines:
            self.assertTrue(any(m.engine == engine for m in catalog.MODELS))

    def test_each_computer_offers_its_acceleration_before_the_processor(self):
        self.assertEqual(machine.backends("macos-aarch64"), ["metal", "cpu"])
        self.assertEqual(machine.backends("linux-x86_64", lambda: True, lambda: True), ["cuda", "vulkan", "cpu"])
        self.assertEqual(machine.backends("windows-x86_64", lambda: False, lambda: True), ["vulkan", "cpu"])
        self.assertEqual(machine.backends("linux-x86_64", lambda: False, lambda: False), ["cpu"])


class Downloading(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.weights = bytes(range(256)) * 4096
        self.site = Site({"model.bin": self.weights, "tokens.txt": b"aspen birch"})
        self.told = []
        self.downloads = Downloads(self.root, lambda: self.told.append(1))

    def tearDown(self):
        self.site.close()
        self.dir.cleanup()

    def test_a_model_is_ready_once_every_file_arrived_as_published(self):
        files = [self.site.file("model.bin"), self.site.file("tokens.txt")]
        self.assertEqual(self.downloads.state("m", files)["state"], "absent")
        seen = []
        self.downloads.start("m", files, done=lambda: seen.append(self.downloads.ready("m", files)))
        self.downloads.wait("m", 10)
        self.assertEqual(self.downloads.state("m", files), {"state": "ready"})
        # What waits for the model finds it ready.
        self.assertEqual(seen, [True])
        self.assertEqual((self.root / "m" / "tokens.txt").read_bytes(), b"aspen birch")
        self.assertTrue(self.told)
        self.downloads.delete("m")
        self.assertEqual(self.downloads.state("m", files)["state"], "absent")

    def test_a_file_that_is_not_as_published_is_refused(self):
        files = [self.site.file("model.bin", "0" * 64)]
        self.downloads.start("m", files)
        self.downloads.wait("m", 10)
        state = self.downloads.state("m", files)
        self.assertEqual(state["state"], "failed")
        self.assertIn("model.bin", state["error"])
        self.assertFalse((self.root / "m" / "model.bin").exists())

    def test_a_download_goes_on_from_where_it_stopped(self):
        files = [self.site.file("model.bin")]
        folder = self.root / "m"
        folder.mkdir()
        (folder / "model.bin.part").write_bytes(self.weights[:1000])
        self.downloads.start("m", files)
        self.downloads.wait("m", 10)
        self.assertEqual(self.downloads.state("m", files), {"state": "ready"})
        self.assertIn("bytes=1000-", self.site.asked)


FAKE_SERVER = textwrap.dedent('''
    import http.server, json, sys
    args = sys.argv[1:]
    open(args[args.index("--model") + 1] + ".args", "w").write(json.dumps(args))
    if "--fail" in open(args[args.index("--model") + 1]).read():
        print("model is broken"); sys.exit(1)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ok"}')
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"])).decode("latin-1")
            prompt = body.split('name="prompt"\\r\\n\\r\\n')[1].split("\\r\\n")[0] if 'name="prompt"' in body else ""
            language = body.split('name="language"\\r\\n\\r\\n')[1].split("\\r\\n")[0]
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps({"text": " heard " + prompt, "language": "italian" if language == "auto" else language}).encode())
    http.server.HTTPServer(("127.0.0.1", int(args[args.index("--port") + 1])), Handler).serve_forever()
''')


class WhisperServer(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "server.py").write_text(FAKE_SERVER)
        self.command = [sys.executable, str(self.root / "server.py")]

    def tearDown(self):
        self.dir.cleanup()

    def test_the_server_holds_the_model_and_hears_with_the_names_and_language(self):
        (self.root / "ggml-model.bin").write_text("weights")
        vad = self.root / "silero.bin"
        engine = WhisperCpp(self.command, "metal", self.root / "server.log", vad, start_seconds=20)
        engine.load(self.root)
        try:
            args = json.loads((self.root / "ggml-model.bin.args").read_text())
            self.assertIn("--vad", args)
            self.assertEqual(args[args.index("--vad-model") + 1], str(vad))
            self.assertNotIn("--no-gpu", args)
            self.assertEqual(engine.transcribe(SPEECH, None, ["Ines", "cedar"]), ("heard Ines, cedar", "italian"))
            self.assertEqual(engine.transcribe(SPEECH, "en", []), ("heard", "en"))
        finally:
            engine.unload()
        self.assertIsNone(engine.process)

    def test_on_the_processor_the_server_is_told_to_leave_the_graphics_card_alone(self):
        (self.root / "ggml-model.bin").write_text("weights")
        engine = WhisperCpp(self.command, "cpu", self.root / "server.log", None, start_seconds=20)
        engine.load(self.root)
        engine.unload()
        args = json.loads((self.root / "ggml-model.bin.args").read_text())
        self.assertIn("--no-gpu", args)
        self.assertNotIn("--vad", args)

    def test_a_server_that_stops_as_it_starts_says_why(self):
        (self.root / "ggml-model.bin").write_text("--fail")
        engine = WhisperCpp(self.command, "cpu", self.root / "server.log", None, start_seconds=20)
        with self.assertRaises(EngineError) as raised:
            engine.load(self.root)
        self.assertIn("model is broken", str(raised.exception))


class Fake:
    """An engine that hears "aspen", or fails on a graphics card when told to."""

    loads: list = []

    def __init__(self, backend, fails_on_gpu=False):
        self.backend = backend
        self.fails = fails_on_gpu

    def load(self, folder):
        Fake.loads.append((folder.name, self.backend))

    def transcribe(self, audio, language, vocabulary):
        if self.fails and self.backend != "cpu":
            raise RuntimeError("device lost")
        return f"aspen {' '.join(vocabulary)}".strip(), language or "Italian"

    def memory(self):
        return 1000

    def unload(self):
        Fake.loads.append(("unloaded", self.backend))


class Keeping(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.now = [0.0]
        self.downloads = Downloads(self.root)
        Fake.loads = []
        self.fails = False
        self.ears = Ears(self.root, self.downloads, Runtimes(self.downloads, "macos-aarch64", ["metal", "cpu"]),
                         clock=lambda: self.now[0],
                         engines={"whisper.cpp": lambda backend: Fake(backend, self.fails),
                                  "parakeet": lambda backend: Fake(backend)})
        self.ears.backend = lambda engine: "metal" if engine == "whisper.cpp" else "cpu"

    def tearDown(self):
        self.dir.cleanup()

    def have(self, id: str) -> Model:
        """A model of the catalog, as if downloaded."""
        model = catalog.model(id)
        folder = self.downloads.folder(model.id)
        folder.mkdir(parents=True)
        # Files of the catalog's size, without writing gigabytes.
        for file in model.files:
            with (folder / file.name).open("wb") as out:
                out.truncate(file.size)
        (folder / ".ready.json").write_text(json.dumps({file.name: file.sha256 for file in model.files}))
        return model

    def test_a_model_not_downloaded_is_asked_for_by_name(self):
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny"))
        with self.assertRaises(EngineError) as raised:
            self.ears.hear(SPEECH, [])
        self.assertIn("Download Whisper tiny", str(raised.exception))

    def test_the_model_loads_once_and_hears_with_the_names(self):
        self.have("whisper.cpp/tiny")
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny", vocabulary=("ZeroLux",)))
        self.ears.ready()
        heard = self.ears.hear(SPEECH, ["Ines"])
        self.assertEqual(heard["text"], "aspen Ines ZeroLux")
        self.assertEqual(heard["language"], "it")
        self.ears.hear(SPEECH, [])
        self.assertEqual(Fake.loads, [("tiny", "metal")])
        self.assertEqual(self.ears.status()["state"], "loaded")

    def test_silence_reaches_no_model(self):
        self.assertEqual(self.ears.hear(np.zeros(16000, dtype=np.float32), [])["text"], "")
        self.assertEqual(self.ears.hear(SPEECH[:1000], [])["text"], "")
        self.assertEqual(Fake.loads, [])

    def test_a_model_kept_for_minutes_goes_after_them_and_comes_back_when_needed(self):
        self.have("whisper.cpp/tiny")
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny", keep=5))
        self.ears.hear(SPEECH, [])
        self.now[0] = 4 * 60
        self.ears.idle()
        self.assertEqual(self.ears.status()["state"], "loaded")
        self.now[0] = 10 * 60
        self.ears.idle()
        self.assertEqual(self.ears.status()["state"], "unloaded")
        self.ears.hear(SPEECH, [])
        self.assertEqual(Fake.loads, [("tiny", "metal"), ("unloaded", "metal"), ("tiny", "metal")])

    def test_a_model_kept_always_stays(self):
        self.have("whisper.cpp/tiny")
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny", keep=0))
        self.ears.hear(SPEECH, [])
        self.now[0] = 24 * 3600
        self.ears.idle()
        self.assertEqual(self.ears.status()["state"], "loaded")

    def test_choosing_another_model_lets_the_one_before_go(self):
        self.have("whisper.cpp/tiny")
        self.have("parakeet/tdt-0.6b-v3-int8")
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny"))
        self.ears.ready()
        self.ears.configure(Config("parakeet", "parakeet/tdt-0.6b-v3-int8"))
        self.assertEqual(self.ears.status()["state"], "unloaded")
        # Parakeet takes no names.
        self.assertEqual(self.ears.hear(SPEECH, ["Ines"])["text"], "aspen")
        with self.assertRaises(ValueError):
            self.ears.configure(Config("parakeet", "whisper.cpp/tiny"))

    def test_a_graphics_card_that_fails_hears_the_same_recording_on_the_processor(self):
        self.have("whisper.cpp/tiny")
        self.fails = True
        self.ears.configure(Config("whisper.cpp", "whisper.cpp/tiny"))
        self.assertEqual(self.ears.hear(SPEECH, [])["text"], "aspen")
        self.assertEqual(self.ears.status()["backend"], "cpu")

    def test_a_kept_choice_is_read_back_and_an_unknown_model_refused(self):
        default = Config("parakeet", "parakeet/tdt-0.6b-v3-int8")
        kept = Config.of({"engine": "whisper.cpp", "model": "whisper.cpp/small", "keep": 15,
                          "vocabulary": ["Ines"]}, default)
        self.assertEqual((kept.model, kept.keep, kept.vocabulary), ("whisper.cpp/small", 15, ("Ines",)))
        self.assertEqual(Config.of(None, default), default)
        with self.assertRaises(ValueError):
            Config.of({"model": "whisper.cpp/huge"}, default)


class Runtime(unittest.TestCase):
    def test_a_pack_voice_downloaded_is_the_server_for_its_acceleration(self):
        with tempfile.TemporaryDirectory() as dir:
            downloads = Downloads(Path(dir))
            runtimes = Runtimes(downloads, "linux-x86_64", ["cuda", "cpu"])
            self.assertIsNone(runtimes.server("cpu"))
            folder = downloads.folder(runtimes.key("cpu"))
            folder.mkdir(parents=True)
            (folder / "whisper-server").write_text("")
            self.assertEqual(runtimes.server("cpu"), [str(folder / "whisper-server")])
            self.assertEqual(runtimes.best(), ("cpu", [str(folder / "whisper-server")]))
            offered = {each["backend"]: each["state"] for each in runtimes.offered()}
            self.assertEqual(offered["cpu"], "ready")


if __name__ == "__main__":
    unittest.main()
