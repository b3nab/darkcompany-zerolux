"""Speaking with an agent's voice: Pocket TTS, the large model with 5 decoding steps at
temperature 0.5, on the CPU, from the agent's print. The print is made once from the voice's
reference recording, for the model that speaks; it starts a voice in 5 seconds instead of 9.

Pocket clones voices only with the weights Kyutai keeps behind a form; the public copy of them
(`lunahr/pocket-tts-ungated`, CC BY 4.0) has Italian and English, and needs pocket-tts 2.1.0's
tokenizer. Italian numbers, times, percentages and amounts are written out first: Pocket reads
their dots and colons as pauses. English ones it reads well."""

import io
import os
import re
import tempfile
import threading
from pathlib import Path

import numpy as np

from italiano import words

# Each language's model: the large one where the copy has it.
MODELS = {"it": "italian_24l", "en": "english"}
WEIGHTS = "hf://lunahr/pocket-tts-ungated/languages/{}/model.safetensors"
STEPS, TEMPERATURE = 5, 0.5


def language_of(text: str, fallback: str) -> str:
    """The language a text is written in, among those Pocket speaks with a cloned voice."""
    from lingua import Language, LanguageDetectorBuilder

    global _detector
    if _detector is None:
        _detector = LanguageDetectorBuilder.from_languages(Language.ITALIAN, Language.ENGLISH).build()
    found = _detector.detect_language_of(text)
    return {Language.ITALIAN: "it", Language.ENGLISH: "en"}.get(found, fallback)


_detector = None


def sentences(text: str) -> list[str]:
    """The text in sentences, the pieces a voice says one after another; code, links and markup
    are not read."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[*_#>|~]+", " ", text)
    parts = re.split(r"(?<=[.!?…])\s+|\n+", text)
    return [re.sub(r"\s+", " ", part).strip() for part in parts if re.search(r"\w", part)]


class Voices:
    """Pocket, loaded once per language, and the voices of the workspace's agents."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.models: dict[str, object] = {}
        self.states: dict[tuple[str, str], object] = {}
        self.lock = threading.Lock()

    def path(self, actor: str) -> Path:
        return self.folder / "voices" / actor

    def model(self, language: str):
        if language not in self.models:
            import pocket_tts
            from pocket_tts import TTSModel

            name = MODELS[language]
            config = Path(pocket_tts.__file__).parent / "config" / f"{name}.yaml"
            source = re.sub(r"(?m)^weights_path: .*$", f"weights_path: {WEIGHTS.format(name)}",
                            config.read_text(), count=1)
            with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as written:
                written.write(source)
            try:
                self.models[language] = TTSModel.load_model(
                    config=written.name, lsd_decode_steps=STEPS, temp=TEMPERATURE)
            finally:
                os.unlink(written.name)
        return self.models[language]

    def state(self, actor: str, language: str):
        """The agent's voice for a language's model: its print, made once from its reference."""
        key = (actor, language)
        if key not in self.states:
            from pocket_tts.models.tts_model import export_model_state

            model = self.model(language)
            reference = self.path(actor) / "voice.wav"
            if not reference.is_file():
                raise ValueError("This agent has no voice")
            voice = reference.with_suffix(f".{MODELS[language]}.safetensors")
            if not voice.exists() or voice.stat().st_mtime < reference.stat().st_mtime:
                export_model_state(model.get_state_for_audio_prompt(str(reference)), voice)
            self.states[key] = model.get_state_for_audio_prompt(str(voice))
        return self.states[key]

    def forget(self, actor: str) -> None:
        with self.lock:
            for key in [key for key in self.states if key[0] == actor]:
                del self.states[key]

    def speak(self, actor: str, text: str, language: str | None, fallback: str) -> dict:
        """A sentence or a few, as WAV."""
        import soundfile as sf

        language = language if language in MODELS else language_of(text, fallback)
        said = words(text) if language == "it" else text
        with self.lock:
            model, state = self.model(language), self.state(actor, language)
            audio = np.concatenate([np.asarray(chunk.numpy(), dtype=np.float32).reshape(-1)
                                    for chunk in model.generate_audio_stream(state, said)])
            rate = model.sample_rate
        out = io.BytesIO()
        sf.write(out, audio, rate, format="WAV", subtype="PCM_16")
        return {"audio": out.getvalue(), "type": "audio/wav", "language": language,
                "seconds": round(len(audio) / rate, 2)}
