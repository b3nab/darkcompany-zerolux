"""Speech to text with the engine and model the workspace chose, kept loaded as it says.

The model loads as Voice starts, and whenever an app opens its microphone (`prepare`), so the
first recording does not wait for it; it stays loaded, or goes after the minutes chosen without
use. Silence never reaches a model: below 0.3 seconds or nearly silent, nothing was said, and
whisper.cpp and faster-whisper hear only the speech their voice activity detection finds. On a
graphics card that fails, the same recording is heard again on the processor."""

import io
import os
import shutil
import sys
import threading
import time
import zipfile
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Callable

import numpy as np

import catalog
import machine
from downloads import Downloads
from engines import EngineError, FasterWhisper, Parakeet, WhisperCpp, resident

RATE = 16000
QUIET = 0.02
NAMES = {"italian": "it", "english": "en", "french": "fr", "german": "de", "spanish": "es",
         "portuguese": "pt", "dutch": "nl", "chinese": "zh", "japanese": "ja"}


def decode(data: bytes) -> np.ndarray:
    """Any recording a browser or phone makes (WebM, Ogg, MP4, WAV…), as 16 kHz mono."""
    import av

    with av.open(io.BytesIO(data)) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        pieces = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                pieces.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            pieces.append(out.to_ndarray().reshape(-1))
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


def code(language) -> str | None:
    """A model's language, as its ISO 639-1 code: some say "Italian", or a list of them."""
    if isinstance(language, list):
        language = language[0] if language else None
    if not language:
        return None
    language = str(language).lower()
    return NAMES.get(language, language if len(language) == 2 else None)


@dataclass(frozen=True)
class Config:
    engine: str
    model: str
    # "auto", or the language spoken.
    language: str = "auto"
    vad: bool = True
    # Minutes without use before the model goes; 0 keeps it.
    keep: int = 0
    # Words to write right besides the workspace's names.
    vocabulary: tuple[str, ...] = ()

    @staticmethod
    def of(kept: dict | None, default: "Config") -> "Config":
        if not kept:
            return default
        fields = {key: kept[key] for key in ("engine", "model", "language", "vad", "keep") if key in kept}
        if "vocabulary" in kept:
            fields["vocabulary"] = tuple(str(word) for word in kept["vocabulary"])
        config = replace(default, **fields)
        catalog.model(config.model)
        return config

    def shown(self) -> dict:
        return {**asdict(self), "vocabulary": list(self.vocabulary)}


class Runtimes:
    """whisper.cpp's server for this computer: a pack Voice downloaded, one named by
    `ZEROLUX_WHISPER_SERVER`, or one on the PATH (Homebrew's)."""

    def __init__(self, downloads: Downloads, platform: str | None = None,
                 backends: list[str] | None = None) -> None:
        self.downloads = downloads
        self.platform = platform or machine.platform_key()
        self.backends = backends if backends is not None else machine.backends(self.platform)

    def key(self, backend: str) -> str:
        return f"runtimes/whisper.cpp/{catalog.WHISPER_CPP}-{self.platform}-{backend}"

    def server(self, backend: str) -> list[str] | None:
        """The command that starts the server built for `backend`, if this computer has it."""
        executable = "whisper-server.exe" if self.platform.startswith("windows") else "whisper-server"
        pack = catalog.runtime(self.platform, backend)
        folder = self.downloads.folder(self.key(backend))
        if (folder / executable).is_file() and (pack.file is None or self.downloads.ready(self.key(backend), [pack.file])):
            return [str(folder / executable)]
        named = os.environ.get("ZEROLUX_WHISPER_SERVER")
        if named and Path(named).is_file() and backend == self.backends[0]:
            return [named]
        found = shutil.which("whisper-server")
        if found and backend == self.backends[0]:
            return [found]
        return None

    def best(self) -> tuple[str, list[str]] | None:
        """The best acceleration with a server here."""
        for backend in self.backends:
            command = self.server(backend)
            if command:
                return backend, command
        return None

    def offered(self) -> list[dict]:
        """Each acceleration this computer has, and whether its server is here or can come."""
        shown = []
        for backend in self.backends:
            pack = catalog.runtime(self.platform, backend)
            state = ({"state": "ready"} if self.server(backend) else
                     self.downloads.state(self.key(backend), [pack.file]) if pack.file else
                     {"state": "unavailable"})
            shown.append({"backend": backend, "size": pack.file.size if pack.file else None, **state})
        return shown

    def install(self, backend: str) -> None:
        pack = catalog.runtime(self.platform, backend)
        if pack.file is None:
            raise ValueError(f"whisper.cpp for {backend} on this computer is not published yet")

        def unpack(folder: Path) -> None:
            with zipfile.ZipFile(folder / pack.file.name) as archive:
                archive.extractall(folder)
            for found in folder.rglob("whisper-server*"):
                found.chmod(0o755)
                if found.parent != folder:
                    found.rename(folder / found.name)

        self.downloads.start(self.key(backend), [pack.file], then=unpack)


class Ears:
    """The chosen model, loaded ahead and kept as the workspace says; one at a time."""

    def __init__(self, folder: Path, downloads: Downloads, runtimes: Runtimes,
                 changed: Callable[[], None] = lambda: None, clock: Callable[[], float] = time.monotonic,
                 engines: dict[str, Callable] | None = None) -> None:
        self.folder = folder
        self.downloads = downloads
        self.runtimes = runtimes
        self.changed = changed
        self.clock = clock
        self.engines = engines or {
            "whisper.cpp": self._whisper_cpp,
            "faster-whisper": lambda backend: FasterWhisper(backend),
            "parakeet": lambda backend: Parakeet(backend),
        }
        self.lock = threading.RLock()
        self.config = self.default()
        self.loaded = None  # (engine, model id, backend)
        self.loading = False
        self.error: str | None = None
        self.used = self.clock()

    # What the workspace chose.

    def default(self) -> Config:
        """Whisper turbo where a graphics card runs it, else Parakeet on the processor."""
        best = self.runtimes.best()
        if best and best[0] != "cpu":
            return Config("whisper.cpp", "whisper.cpp/large-v3-turbo-q5_0")
        if "cuda" in self.runtimes.backends:
            return Config("faster-whisper", "faster-whisper/large-v3-turbo")
        return Config("parakeet", "parakeet/tdt-0.6b-v3-int8")

    def configure(self, config: Config) -> None:
        model = catalog.model(config.model)
        if model.engine != config.engine:
            raise ValueError(f"{model.title} does not run with {config.engine}")
        with self.lock:
            moved = (config.engine, config.model) != (self.config.engine, self.config.model)
            vad = config.vad != self.config.vad
            self.config = config
            if moved or vad:
                self.unload()
        self.changed()

    def backend(self, engine: str) -> str:
        if engine == "whisper.cpp":
            best = self.runtimes.best()
            return best[0] if best else self.runtimes.backends[0]
        if engine == "faster-whisper":
            return "cuda" if "cuda" in self.runtimes.backends and machine.cuda_devices() else "cpu"
        return "cpu"

    def _whisper_cpp(self, backend: str) -> WhisperCpp:
        command = self.runtimes.server(backend)
        if not command:
            raise EngineError("whisper.cpp is not installed on this computer: install it in Voice's settings")
        vad = None
        if self.config.vad:
            if not self.downloads.ready("vad", catalog.VAD):
                self.downloads.start("vad", catalog.VAD)
                self.downloads.wait("vad", 120)
            if self.downloads.ready("vad", catalog.VAD):
                vad = self.downloads.folder("vad") / catalog.VAD[0].name
        return WhisperCpp(command, backend, self.folder / "logs" / "whisper-server.log", vad)

    # Loading.

    def ready(self, backend: str | None = None) -> None:
        """Loads the chosen model, unless it is loaded or not downloaded yet."""
        with self.lock:
            config = self.config
            model = catalog.model(config.model)
            backend = backend or self.backend(config.engine)
            if self.loaded and self.loaded[1:] == (config.model, backend):
                return
            if not self.downloads.ready(model.id, model.files):
                raise EngineError(f"Download {model.title} ({model.variant}) in Voice's settings")
            self.unload()
            self.loading, self.error = True, None
            self.changed()
            try:
                engine = self.engines[config.engine](backend)
                if isinstance(engine, FasterWhisper):
                    engine.vad = config.vad
                engine.load(self.downloads.folder(model.id))
                self.loaded = (engine, config.model, backend)
                self.used = self.clock()
            except Exception as error:
                self.error = str(error)
                raise
            finally:
                self.loading = False
                self.changed()

    def unload(self) -> None:
        with self.lock:
            if self.loaded:
                self.loaded[0].unload()
                self.loaded = None
                self.changed()

    def idle(self) -> None:
        """Lets the model go once it has rested as long as the workspace allows."""
        keep = self.config.keep
        if keep and self.loaded and not self.loading and self.clock() - self.used > keep * 60:
            with self.lock:
                if self.loaded and self.clock() - self.used > keep * 60:
                    self.unload()

    # Hearing.

    def hear(self, audio: np.ndarray, names: list[str], language: str | None = None) -> dict:
        """What was said: its text, and its language when the engine tells it."""
        seconds = len(audio) / RATE
        if seconds < 0.3 or float(np.abs(audio).max(initial=0)) < QUIET:
            return {"text": "", "language": None, "seconds": round(seconds, 2)}
        with self.lock:
            config = self.config
            language = language or (None if config.language == "auto" else config.language)
            vocabulary = [*names, *config.vocabulary] if catalog.model(config.model).vocabulary else []
            self.ready()
            engine, _, backend = self.loaded
            try:
                text, heard = engine.transcribe(audio, language, vocabulary)
            except Exception as error:
                if backend == "cpu":
                    raise
                # The graphics card failed: the same recording, on the processor.
                print(f"Transcription on {backend} failed, again on the processor: {error}", file=sys.stderr)
                self.ready("cpu")
                engine = self.loaded[0]
                text, heard = engine.transcribe(audio, language, vocabulary)
            self.used = self.clock()
        return {"text": text, "language": code(heard), "seconds": round(seconds, 2)}

    def status(self) -> dict:
        loaded = self.loaded
        memory = None
        if loaded:
            memory = loaded[0].memory() or resident(os.getpid())
        return {
            "state": "loading" if self.loading else "loaded" if loaded else "failed" if self.error else "unloaded",
            "model": loaded[1] if loaded else None,
            "backend": loaded[2] if loaded else None,
            "memory": memory,
            "error": self.error,
            "idle": int(self.clock() - self.used) if loaded else None,
        }
