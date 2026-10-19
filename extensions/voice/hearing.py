"""Speech to text, with the model the workspace chose. On a Mac with Apple silicon the models
run with MLX; elsewhere Whisper runs with faster-whisper and Parakeet with ONNX Runtime.

On a short sound that is not speech, Whisper writes "Grazie." with full confidence, or loops
once it has a vocabulary: a stretch up to 5 seconds keeps Whisper's text only if Parakeet,
which writes nothing on noise, heard a word of it. Below 0.3 seconds or nearly silent, nothing
was said."""

import io
import platform
import re
import sys
import threading

import numpy as np

RATE = 16000
APPLE = sys.platform == "darwin" and platform.machine() == "arm64"
SHORT = 5.0
QUIET = 0.02

# Each model: its MLX weights, and what runs it elsewhere. Whisper writes names right when it
# is given them; Parakeet and Qwen3-ASR take no vocabulary.
MODELS = {
    "whisper": {"mlx": "mlx-community/whisper-large-v3-turbo-asr-fp16", "other": "large-v3-turbo"},
    "parakeet": {"mlx": "mlx-community/parakeet-tdt-0.6b-v3", "other": "nemo-parakeet-tdt-0.6b-v3"},
    "qwen3": {"mlx": "mlx-community/Qwen3-ASR-0.6B-8bit", "other": None},
}


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


NAMES = {"italian": "it", "english": "en", "french": "fr", "german": "de", "spanish": "es",
         "portuguese": "pt", "dutch": "nl", "chinese": "zh", "japanese": "ja"}


def code(language) -> str | None:
    """A model's language, as its ISO 639-1 code: some say "Italian", or a list of them."""
    if isinstance(language, list):
        language = language[0] if language else None
    if not language:
        return None
    language = str(language).lower()
    return NAMES.get(language, language if len(language) == 2 else None)


def agree(a: str, b: str) -> bool:
    """Two models heard the same thing: a word in common."""
    found = lambda text: set(re.findall(r"\w{2,}", text.lower()))  # noqa: E731
    return bool(found(a) & found(b))


class Ears:
    """The chosen model, loaded once it is used, and Parakeet as the gate; one at a time."""

    def __init__(self) -> None:
        self.models: dict[str, object] = {}
        self.lock = threading.Lock()

    def _model(self, name: str):
        if name not in self.models:
            spec = MODELS.get(name)
            if spec is None:
                raise ValueError(f"No transcription model `{name}`")
            # One model besides the gate: switching frees the other.
            for other in [key for key in self.models if key not in (name, "parakeet")]:
                del self.models[other]
            if APPLE:
                from mlx_audio.stt.utils import load_model

                self.models[name] = load_model(spec["mlx"])
            elif name == "whisper":
                from faster_whisper import WhisperModel

                self.models[name] = WhisperModel(spec["other"], device="auto", compute_type="default")
            elif name == "parakeet":
                import onnx_asr

                self.models[name] = onnx_asr.load_model(spec["other"])
            else:
                raise ValueError("Qwen3-ASR runs only on a Mac with Apple silicon: choose Whisper or Parakeet")
        return self.models[name]

    def _hear(self, name: str, audio: np.ndarray, vocabulary: list[str]) -> tuple[str, str | None]:
        model = self._model(name)
        if APPLE:
            import mlx.core as mx

            options = {"hotwords": vocabulary} if name == "whisper" and vocabulary else {}
            result = model.generate(mx.array(audio), **options)
            return result.text.strip(), code(getattr(result, "language", None))
        if name == "whisper":
            segments, info = model.transcribe(audio, hotwords=" ".join(vocabulary) or None)
            return "".join(segment.text for segment in segments).strip(), info.language
        return model.recognize(audio, sample_rate=RATE).strip(), None

    def hear(self, audio: np.ndarray, name: str, vocabulary: list[str], gate: bool = True) -> dict:
        """What was said: its text, and its language when the model tells it. Without `gate`,
        for speech known to be speech, Parakeet is not asked."""
        seconds = len(audio) / RATE
        if seconds < 0.3 or float(np.abs(audio).max(initial=0)) < QUIET:
            return {"text": "", "language": None, "seconds": round(seconds, 2)}
        with self.lock:
            text, language = self._hear(name, audio, vocabulary)
            if gate and text and name == "whisper" and seconds <= SHORT:
                gate, _ = self._hear("parakeet", audio, [])
                if not agree(gate, text):
                    text = ""
        return {"text": text, "language": language, "seconds": round(seconds, 2)}
