"""Speaking with an agent's voice, with Pocket TTS on the CPU: from its print, a file made once
from the agent's reference recording, in the language of the text. Numbers, dates and times
are written out first, since Pocket reads their punctuation as pauses."""

import io
import os
import re
import tempfile
import threading
from pathlib import Path

import numpy as np

# Pocket's languages, with the weights that clone voices: the public copy of Kyutai's
# CC BY 4.0 weights, which needs pocket-tts 2.1.0's tokenizer.
LANGUAGES = {"it": "italian", "en": "english", "fr": "french", "de": "german", "es": "spanish",
             "pt": "portuguese", "nl": "dutch"}
WEIGHTS = "hf://lunahr/pocket-tts-ungated/languages/{}/model.safetensors"


def language_of(text: str, fallback: str) -> str:
    """The language a text is written in, among Pocket's."""
    from lingua import IsoCode639_1, LanguageDetectorBuilder

    global _detector
    if _detector is None:
        _detector = LanguageDetectorBuilder.from_iso_codes_639_1(
            *(getattr(IsoCode639_1, code.upper()) for code in LANGUAGES)).build()
    found = _detector.detect_language_of(text)
    return found.iso_code_639_1.name.lower() if found else fallback


_detector = None

_TIME = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b")
_NUMBER = re.compile(r"(?<![\w.,])(\d{1,3}(?:[.,\u202f ]\d{3})+|\d+)(?:([.,])(\d+))?(?![\w])")
_PERCENT = {"it": "per cento", "en": "percent", "fr": "pour cent", "de": "Prozent",
            "es": "por ciento", "pt": "por cento", "nl": "procent"}


def words(text: str, language: str) -> str:
    """Times, numbers and percentages written out, as a reader says them."""
    from num2words import num2words

    def number(value: str) -> str:
        return num2words(int(value), lang=language)

    text = _TIME.sub(lambda m: f"{number(m.group(1))} e {number(m.group(2))}" if language == "it"
                     else f"{number(m.group(1))} {number(m.group(2))}", text)

    def whole(match: re.Match) -> str:
        integer = re.sub(r"[.,\u202f ]", "", match.group(1))
        said = number(integer)
        if match.group(3):
            point = {"it": "virgola", "en": "point", "fr": "virgule", "de": "Komma", "es": "coma",
                     "pt": "vírgula", "nl": "komma"}[language]
            said += f" {point} " + " ".join(number(digit) for digit in match.group(3))
        return said

    text = _NUMBER.sub(whole, text)
    return text.replace("%", f" {_PERCENT[language]}")


def sentences(text: str) -> list[str]:
    """The text in sentences, the pieces a voice says one after another."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_#>|]+", " ", text)
    parts = re.split(r"(?<=[.!?…:;])\s+|\n+", text)
    return [part.strip() for part in parts if re.search(r"\w", part)]


class Voices:
    """Pocket, loaded per language, and the voices of the workspace's agents."""

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

            name = LANGUAGES[language]
            config = Path(pocket_tts.__file__).parent / "config" / f"{name}.yaml"
            source = config.read_text()
            source = re.sub(r"(?m)^weights_path: .*$", f"weights_path: {WEIGHTS.format(name)}", source, count=1)
            with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as written:
                written.write(source)
            try:
                self.models[language] = TTSModel.load_model(config=written.name, lsd_decode_steps=5, temp=0.7)
            finally:
                os.unlink(written.name)
        return self.models[language]

    def state(self, actor: str, language: str):
        """The agent's voice in a language: its print, made once from its reference."""
        key = (actor, language)
        if key not in self.states:
            from pocket_tts.models.tts_model import export_model_state

            model = self.model(language)
            reference = self.path(actor) / "reference.wav"
            if not reference.is_file():
                raise ValueError("This agent has no voice yet: create one first")
            voice = self.path(actor) / f"print.{LANGUAGES[language]}.safetensors"
            if not voice.exists():
                export_model_state(model.get_state_for_audio_prompt(str(reference)), voice)
            self.states[key] = model.get_state_for_audio_prompt(str(voice))
        return self.states[key]

    def forget(self, actor: str) -> None:
        with self.lock:
            for key in [key for key in self.states if key[0] == actor]:
                del self.states[key]

    def speak(self, actor: str, text: str, language: str | None, fallback: str) -> dict:
        """One sentence or a few, as WAV."""
        import soundfile as sf

        language = language if language in LANGUAGES else language_of(text, fallback)
        said = words(text, language)
        with self.lock:
            model, state = self.model(language), self.state(actor, language)
            audio = np.concatenate([np.asarray(chunk.numpy(), dtype=np.float32).reshape(-1)
                                    for chunk in model.generate_audio_stream(state, said)])
            rate = model.sample_rate
        out = io.BytesIO()
        sf.write(out, audio, rate, format="WAV", subtype="PCM_16")
        return {"audio": out.getvalue(), "type": "audio/wav", "language": language,
                "seconds": round(len(audio) / rate, 2)}
