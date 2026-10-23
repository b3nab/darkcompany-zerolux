"""The engines Voice hears with, each holding one model while it is loaded:

- whisper.cpp, native: its `whisper-server`, started with the model and asked over HTTP on this
  computer only; Metal, CUDA or Vulkan when its build has them, else the processor.
- faster-whisper, CTranslate2 in this process: CUDA on an NVIDIA card, else INT8 on the
  processor.
- Parakeet v3, ONNX Runtime through sherpa-onnx in this process, on the processor.

None of them needs PyTorch. Audio comes as 16 kHz mono float32."""

import io
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

import numpy as np

import machine

RATE = 16000


class EngineError(Exception):
    """An engine that failed, with what it said."""


def wav(audio: np.ndarray) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(RATE)
        file.writeframes(pcm)
    return out.getvalue()


def multipart(fields: dict[str, str], name: str, data: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                 "Content-Type: audio/wav\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class WhisperCpp:
    """whisper.cpp's server, holding the model until it is stopped."""

    id = "whisper.cpp"

    def __init__(self, command: list[str], backend: str, log: Path, vad: Path | None = None,
                 start_seconds: float = 180) -> None:
        self.command = command
        self.backend = backend
        self.log = log
        self.vad = vad
        self.start_seconds = start_seconds
        self.process: subprocess.Popen | None = None
        self.port = 0

    def arguments(self, model: Path) -> list[str]:
        args = [*self.command, "--model", str(model), "--host", "127.0.0.1", "--port", str(self.port),
                "--threads", str(machine.threads()), "--language", "auto",
                # The language heard is enough: its probabilities slow each recording down.
                "--no-language-probabilities"]
        if self.backend == "cpu":
            args.append("--no-gpu")
        if self.vad:
            args += ["--vad", "--vad-model", str(self.vad)]
        return args

    def load(self, folder: Path) -> None:
        model = next(folder.glob("*.bin"))
        self.port = free_port()
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with self.log.open("ab") as out:
            self.process = subprocess.Popen(self.arguments(model), stdout=out, stderr=subprocess.STDOUT,
                                            stdin=subprocess.DEVNULL)
        deadline = time.monotonic() + self.start_seconds
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise EngineError(f"whisper.cpp stopped as it started: {self.said()}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as answer:
                    if answer.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.1)
        self.unload()
        raise EngineError("whisper.cpp did not start in time")

    def said(self) -> str:
        try:
            lines = self.log.read_text(errors="replace").strip().splitlines()
        except OSError:
            return ""
        return lines[-1] if lines else ""

    def transcribe(self, audio: np.ndarray, language: str | None, vocabulary: list[str]) -> tuple[str, str | None]:
        if not self.process or self.process.poll() is not None:
            raise EngineError(f"whisper.cpp is not running: {self.said()}")
        fields = {"temperature": "0.0", "response_format": "verbose_json",
                  "language": language or "auto"}
        if vocabulary:
            fields["prompt"] = ", ".join(vocabulary)
        body, kind = multipart(fields, "audio.wav", wav(audio))
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/inference", data=body,
                                         headers={"Content-Type": kind})
        try:
            with urllib.request.urlopen(request, timeout=300) as answer:
                result = json.load(answer)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise EngineError(f"whisper.cpp did not answer: {error}") from error
        if "error" in result:
            raise EngineError(str(result["error"]))
        return str(result.get("text", "")).strip(), result.get("language")

    def memory(self) -> int | None:
        if not self.process:
            return None
        return resident(self.process.pid)

    def unload(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None


class FasterWhisper:
    id = "faster-whisper"

    def __init__(self, backend: str) -> None:
        self.backend = backend
        self.model = None
        self.vad = True

    def load(self, folder: Path) -> None:
        from faster_whisper import WhisperModel

        cuda = self.backend == "cuda"
        self.model = WhisperModel(str(folder), device="cuda" if cuda else "cpu",
                                  compute_type="float16" if cuda else "int8",
                                  cpu_threads=machine.threads())

    def transcribe(self, audio: np.ndarray, language: str | None, vocabulary: list[str]) -> tuple[str, str | None]:
        segments, info = self.model.transcribe(
            audio, language=language, vad_filter=self.vad, condition_on_previous_text=False,
            hotwords=" ".join(vocabulary) or None)
        return "".join(segment.text for segment in segments).strip(), info.language

    def memory(self) -> int | None:
        return None

    def unload(self) -> None:
        self.model = None


class Parakeet:
    id = "parakeet"

    def __init__(self, backend: str = "cpu") -> None:
        self.backend = "cpu"
        self.recognizer = None

    def load(self, folder: Path) -> None:
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(folder / "encoder.int8.onnx"), decoder=str(folder / "decoder.int8.onnx"),
            joiner=str(folder / "joiner.int8.onnx"), tokens=str(folder / "tokens.txt"),
            model_type="nemo_transducer", num_threads=machine.threads(), provider="cpu")

    def transcribe(self, audio: np.ndarray, language: str | None, vocabulary: list[str]) -> tuple[str, str | None]:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(RATE, audio)
        self.recognizer.decode_stream(stream)
        result = stream.result
        return result.text.strip(), getattr(result, "lang", None) or None

    def memory(self) -> int | None:
        return None

    def unload(self) -> None:
        self.recognizer = None


def resident(pid: int) -> int | None:
    """A process's resident memory, in bytes, where `ps` tells it."""
    if sys.platform == "win32":
        return None
    try:
        found = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return int(found.stdout.strip()) * 1024 if found.returncode == 0 and found.stdout.strip() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
