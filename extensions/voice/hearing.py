"""Speech to text, with the model the workspace chose. On a Mac with Apple silicon the models
run with MLX; elsewhere Whisper runs with faster-whisper and Parakeet with ONNX Runtime."""

import io
import platform
import sys
import threading

import numpy as np

RATE = 16000
APPLE = sys.platform == "darwin" and platform.machine() == "arm64"

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


class Ears:
    """One model loaded at a time, the one chosen last; one transcription at a time."""

    def __init__(self) -> None:
        self.name: str | None = None
        self.model = None
        self.lock = threading.Lock()

    def _load(self, name: str) -> None:
        if name == self.name:
            return
        spec = MODELS.get(name)
        if spec is None:
            raise ValueError(f"No transcription model `{name}`")
        self.model, self.name = None, None
        if APPLE:
            from mlx_audio.stt.utils import load_model

            self.model = load_model(spec["mlx"])
        elif name == "whisper":
            from faster_whisper import WhisperModel

            self.model = WhisperModel(spec["other"], device="auto", compute_type="default")
        elif name == "parakeet":
            import onnx_asr

            self.model = onnx_asr.load_model(spec["other"])
        else:
            raise ValueError("Qwen3-ASR runs only on a Mac with Apple silicon: choose Whisper or Parakeet")
        self.name = name

    def hear(self, audio: np.ndarray, name: str, vocabulary: list[str]) -> dict:
        """What was said: its text, and its language when the model tells it."""
        seconds = len(audio) / RATE
        # Below this, Whisper writes sentences that were never said.
        if seconds < 0.3 or float(np.abs(audio).max(initial=0)) < 0.02:
            return {"text": "", "language": None, "seconds": round(seconds, 2)}
        with self.lock:
            self._load(name)
            if APPLE:
                options = {"hotwords": vocabulary} if name == "whisper" and vocabulary else {}
                result = self.model.generate(audio, **options)
                text, language = result.text, getattr(result, "language", None)
            elif name == "whisper":
                segments, info = self.model.transcribe(
                    audio, hotwords=" ".join(vocabulary) or None, vad_filter=True)
                text, language = "".join(segment.text for segment in segments), info.language
            else:
                text, language = self.model.recognize(audio, sample_rate=RATE), None
        return {"text": text.strip(), "language": language, "seconds": round(seconds, 2)}
