"""A new voice for an agent, with VoxCPM2. From a description of the agent's voice, in English
(VoxCPM2 reads only English and Chinese descriptions), three voices each say a greeting; the
one chosen then reads half a minute of text with every sound of the language, and that
recording is the voice's reference, which Pocket clones.

Each recording is the best of a few takes: of those that say the text (heard back by the
transcription model), the one whose voice stands farthest above its background, which is what
Ben's ear chose by in the prototype. On a Mac with Apple silicon VoxCPM2 runs with MLX;
elsewhere with PyTorch, on the GPU when there is one."""

import platform
import re
import sys
import threading
import unicodedata

import numpy as np

APPLE = sys.platform == "darwin" and platform.machine() == "arm64"
LONGEST = 30.0  # Pocket reads the first 30 seconds of a reference

GREETING = {
    "it": "Ciao, sono {}. Questa è una delle voci che potrei avere: ascoltala bene.",
    "en": "Hi, I'm {}. This is one of the voices I could have: listen to it carefully.",
}
# Every sound of the language, with questions and exclamations, in about half a minute.
SOUNDS = {
    "it": ("Ciao Ben, sono {}. Lavoro nel team di ZeroLux, con le persone e con gli altri agenti. Ti va se oggi "
           "ascoltiamo insieme come suona la mia voce? Ogni mattina leggo, scrivo e controllo il lavoro; verso "
           "mezzogiorno faccio il punto, e se qualcosa non mi convince, lo dico subito e non lascio correre. Perché "
           "lo faccio? Perché mi piace. Mi bastano poche cose: un'idea chiara, un po' di pazienza e la voglia di "
           "fare sempre meglio. Ieri, per esempio, ho corretto tre errori in un quarto d'ora. Che soddisfazione! E "
           "la cosa più bella? Imparare ogni giorno. Adesso tocca anche a te: dimmi pure cosa ne pensi, e grazie."),
    "en": ("Hi Ben, I'm {}. I work in the ZeroLux team, with people and with the other agents. Shall we listen "
           "together to how my voice sounds today? Every morning I read, write and check the work; around noon I "
           "take stock, and if something doesn't convince me, I say so at once. Why do I do it? Because I enjoy "
           "it. I need just a few things: a clear idea, a little patience and the wish to keep getting better. "
           "Yesterday, for example, I fixed three bugs in a quarter of an hour. What a joy! And the best part? "
           "Learning something every day. Now it's your turn: tell me what you think, and thank you."),
}


def mono(audio) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    return audio.mean(axis=int(np.argmin(audio.shape))) if audio.ndim == 2 else audio.reshape(-1)


def letters(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return re.sub(r"[^a-z0-9]", "", text)


def cer(expected: str, heard: str) -> float:
    """Character error rate of what was heard."""
    a, b = letters(expected), letters(heard)
    if not a:
        return 0.0 if not b else 1.0
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1] / len(a)


def background_gap(audio: np.ndarray, rate: int) -> float:
    """How far the voice stands above the background between its words, in dB: the loud and
    the quiet end (90th and 10th percentile) of its 50 ms frames, from the first word to the last."""
    frame = int(rate * 0.05)
    db = 10 * np.log10((audio[: len(audio) // frame * frame].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
    spoken = np.flatnonzero(db > db.max() - 40)
    if len(spoken) == 0:
        return 0.0
    db = db[spoken[0]: spoken[-1] + 1]
    db = db[db > -100]
    return float(np.percentile(db, 90) - np.percentile(db, 10))


def last_pause(audio: np.ndarray, rate: int, seconds: float) -> int:
    """Where to cut within `seconds`: the middle of the last pause (150 ms quieter than the
    voice by 35 dB) that ends before then, so no word is cut."""
    frame = int(rate * 0.05)
    db = 10 * np.log10((audio[: len(audio) // frame * frame].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
    quiet = db < db.max() - 35
    end = int(seconds * rate) // frame
    pauses = [i for i in range(3, end) if quiet[i - 3:i].all()]
    return (pauses[-1] - 2) * frame if pauses else end * frame


class Designer:
    def __init__(self, hear) -> None:
        """`hear(audio, rate, language)` writes what a take says."""
        self.hear = hear
        self.model = None
        self.lock = threading.Lock()

    def _load(self):
        if self.model is None:
            if APPLE:
                from mlx_audio.tts.utils import load_model

                self.model = load_model("mlx-community/VoxCPM2-8bit")
            else:
                from voxcpm import VoxCPM

                self.model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
        return self.model

    def _say(self, text: str, description: str | None, reference: tuple[str, str] | None):
        model = self._load()
        if APPLE:
            options = {"ref_audio": reference[0], "ref_text": reference[1]} if reference else {
                "instruct": description}
            results = list(model.generate(text=text, **options))
            rate = getattr(results[0], "sample_rate", None) or model.sample_rate
            return np.concatenate([mono(result.audio) for result in results]), rate
        if reference:
            audio = model.generate(text=text, prompt_wav_path=reference[0], prompt_text=reference[1],
                                   reference_wav_path=reference[0])
        else:
            audio = model.generate(text=f"({description}){text}")
        return mono(audio), model.tts_model.sample_rate

    def best(self, takes: int, text: str, language: str, *, description: str | None = None,
             reference: tuple[str, str] | None = None, longest: float | None = None) -> tuple[np.ndarray, int]:
        """Of `takes` takes that say `text`, the cleanest."""
        best = None
        for _ in range(takes):
            take, rate = self._say(text, description, reference)
            cut = bool(longest) and len(take) / rate > longest
            if cut:
                take = take[:last_pause(take, rate, longest)]
            heard = letters(self.hear(take, rate, language))
            expected = letters(text)[: len(heard) if cut else None]  # a cut take says the start
            key = (max(cer(expected, heard), 0.02), -background_gap(take, rate))
            if best is None or key < best[0]:
                best = (key, take, rate)
        return best[1], best[2]

    def propose(self, name: str, description: str, language: str, count: int = 3) -> list[tuple]:
        """Voices that fit the description, each saying a greeting: (audio, rate, text)."""
        text = GREETING.get(language, GREETING["en"]).format(name)
        with self.lock:
            return [(*self.best(2, text, language, description=description), text) for _ in range(count)]

    def reference(self, name: str, proposal: str, proposal_text: str, language: str) -> tuple:
        """The chosen voice reading every sound of its language: its reference."""
        text = SOUNDS.get(language, SOUNDS["en"]).format(name)
        with self.lock:
            return self.best(3, text, language, reference=(proposal, proposal_text), longest=LONGEST)
