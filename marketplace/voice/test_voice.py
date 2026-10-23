"""What the voice does without its models: numbers in words, sentences, the gate's agreement,
languages' codes and the scores that choose a take.

    uv run --no-project --with numpy python -m unittest discover -s marketplace/voice
"""

import unittest

import numpy as np

from designing import background_gap, cer, last_pause
from hearing import Ears, agree, code
from italiano import words
from speaking import sentences


class Voice(unittest.TestCase):
    def test_italian_numbers_times_and_amounts_are_written_out(self):
        self.assertEqual(
            words("Il 9 ottobre 2026 alle 14:30 abbiamo 1.250 utenti, il 37% su iOS, 4.800 €."),
            "Il nove ottobre duemilaventisei alle quattordici e trenta abbiamo milleduecentocinquanta "
            "utenti, il trentasette per cento su iOS, quattromilaottocento euro.",
        )
        self.assertEqual(words("versione 3.2, 0,05"), "versione tre punto due, zero virgola zero cinque")

    def test_a_message_is_said_sentence_by_sentence_without_code_links_or_markup(self):
        text = "**Fatto.** Vedi [il PR](https://example.com/1)!\n\n```sh\nrm -rf /\n```\nCi sei? `ok`"
        self.assertEqual(sentences(text), ["Fatto.", "Vedi il PR!", "Ci sei?", "ok"])

    def test_the_gate_keeps_a_text_only_if_both_models_heard_a_word_of_it(self):
        self.assertTrue(agree("è un prototipo", "E sempre un prototipo"))
        self.assertFalse(agree("Yeah, yeah.", "Grazie."))

    def test_a_model_language_is_its_code(self):
        self.assertEqual(code(["Italian"]), "it")
        self.assertEqual(code("en"), "en")
        self.assertIsNone(code(None))

    def test_a_take_is_scored_by_what_it_says_and_how_clean_it_is(self):
        self.assertEqual(cer("Ciao, Alba!", "ciao alba"), 0.0)
        self.assertGreater(cer("Ciao Alba", "Grazie"), 0.5)
        rate = 16000
        t = np.arange(rate) / rate
        voice = np.sin(2 * np.pi * 220 * t).astype(np.float32)
        quiet = np.concatenate([voice, voice * 0.0001, voice])
        noisy = np.concatenate([voice, voice * 0.1, voice])
        self.assertGreater(background_gap(quiet, rate), background_gap(noisy, rate))
        # A cut falls in the pause, before the limit.
        cut = last_pause(quiet, rate, 2.5)
        self.assertTrue(rate < cut < 2 * rate)


if __name__ == "__main__":
    unittest.main()


class Loaded(Ears):
    """Ears whose models are names, loaded without their libraries."""

    def __init__(self) -> None:
        super().__init__()
        self.loads: list[str] = []

    def _load(self, name, spec):
        self.loads.append(name)
        return name

    def _hear(self, name, audio, vocabulary):
        self._model(name)
        return "aspen", None


class Ready(unittest.TestCase):
    def test_the_chosen_model_and_its_gate_are_loaded_ahead_and_once(self):
        ears = Loaded()
        ears.ready("whisper")
        self.assertEqual(sorted(ears.models), ["parakeet", "whisper"])
        ears.ready("whisper")
        # The gate heard after Whisper keeps Whisper loaded.
        ears.hear(np.full(16000, 0.5, dtype=np.float32), "whisper", [])
        self.assertEqual(ears.loads, ["whisper", "parakeet"])

    def test_choosing_another_model_frees_the_one_before_and_keeps_the_gate(self):
        ears = Loaded()
        ears.ready("whisper")
        ears.ready("qwen3")
        self.assertEqual(sorted(ears.models), ["parakeet", "qwen3"])
        with self.assertRaises(ValueError):
            ears.ready("unknown")
