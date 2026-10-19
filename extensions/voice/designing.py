"""A new voice for an agent, with VoxCPM2: three proposals from a description of it, then the
chosen one reads a half-minute text with every sound of its language. That recording is the
voice's reference, from which Pocket speaks. On a Mac with Apple silicon VoxCPM2 runs with
MLX; elsewhere with PyTorch, on the GPU when there is one."""

import platform
import sys
import threading

import numpy as np

APPLE = sys.platform == "darwin" and platform.machine() == "arm64"

GREETING = {
    "it": "Ciao, sono {}. Questa è una delle voci che potrei avere: ascoltala bene.",
    "en": "Hi, I'm {}. This is one of the voices I could have: listen to it carefully.",
}
# Every sound of the language, questions and exclamations, in about half a minute.
SOUNDS = {
    "it": ("Ciao, sono {}. Lavoro nel team, con le persone e con gli altri agenti. Ti va se oggi ascoltiamo "
           "insieme come suona la mia voce? Ogni mattina leggo, scrivo e controllo il lavoro; verso mezzogiorno "
           "faccio il punto, e se qualcosa non mi convince, lo dico subito e non lascio correre. Perché lo faccio? "
           "Perché mi piace. Mi bastano poche cose: un'idea chiara, un po' di pazienza e la voglia di fare sempre "
           "meglio. Ieri, per esempio, ho corretto tre errori in un quarto d'ora. Che soddisfazione! E la cosa più "
           "bella? Imparare ogni giorno. Adesso tocca anche a te: dimmi pure cosa ne pensi, e grazie."),
    "en": ("Hi, I'm {}. I work with the team, with people and with the other agents. Shall we listen together to "
           "how my voice sounds today? Every morning I read, write and check the work; around noon I take stock, "
           "and if something doesn't convince me, I say so at once. Why do I do it? Because I enjoy it. I need just "
           "a few things: a clear idea, a little patience and the wish to keep getting better. Yesterday, for "
           "example, I fixed three bugs in a quarter of an hour. What a joy! And the best part? Learning something "
           "every day. Now it's your turn: tell me what you think, and thank you."),
}


def mono(audio) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    return audio.mean(axis=int(np.argmin(audio.shape))) if audio.ndim == 2 else audio.reshape(-1)


def background_gap(audio: np.ndarray, rate: int) -> float:
    """How far the voice stands above the background between its words, in dB: what Ben's ear
    chose by, in the prototype."""
    frame = int(rate * 0.05)
    db = 10 * np.log10((audio[: len(audio) // frame * frame].reshape(-1, frame) ** 2).mean(axis=1) + 1e-12)
    spoken = np.flatnonzero(db > db.max() - 40)
    if len(spoken) == 0:
        return 0.0
    db = db[spoken[0]: spoken[-1] + 1]
    db = db[db > -100]
    return float(np.percentile(db, 90) - np.percentile(db, 10))


class Designer:
    def __init__(self) -> None:
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

    def _say(self, text: str, description: str | None = None, reference: tuple[str, str] | None = None):
        model = self._load()
        if APPLE:
            options = {"instruct": description} if description else {}
            if reference:
                options = {"ref_audio": reference[0], "ref_text": reference[1]}
            results = list(model.generate(text=text, **options))
            rate = getattr(results[0], "sample_rate", None) or model.sample_rate
            return np.concatenate([mono(result.audio) for result in results]), rate
        if reference:
            audio = model.generate(text=text, prompt_wav_path=reference[0], prompt_text=reference[1],
                                   reference_wav_path=reference[0])
        else:
            audio = model.generate(text=f"({description}){text}")
        return mono(audio), model.tts_model.sample_rate

    def _cleanest(self, takes: int, **say) -> tuple[np.ndarray, int]:
        best = None
        for _ in range(takes):
            audio, rate = self._say(**say)
            gap = background_gap(audio, rate)
            if best is None or gap > best[0]:
                best = (gap, audio, rate)
        return best[1], best[2]

    def propose(self, name: str, description: str, language: str, count: int = 3) -> list[tuple]:
        """Voices that fit the description, each saying a greeting: (audio, rate, text)."""
        text = GREETING.get(language, GREETING["en"]).format(name)
        with self.lock:
            return [(*self._cleanest(2, text=text, description=description), text) for _ in range(count)]

    def reference(self, name: str, proposal: str, proposal_text: str, language: str) -> tuple:
        """The chosen voice reading every sound of its language: its reference."""
        text = SOUNDS.get(language, SOUNDS["en"]).format(name)
        with self.lock:
            audio, rate = self._cleanest(2, text=text, reference=(proposal, proposal_text))
        # Pocket reads the first 30 seconds.
        return audio[: rate * 30], rate
