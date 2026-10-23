# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "numpy",
#   "soundfile",
#   "av",
#   "num2words",
#   "lingua-language-detector",
#   "sentencepiece",
#   "pocket-tts==2.1.0",
#   "mlx-audio>=0.5.8; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "faster-whisper>=1.2; sys_platform != 'darwin' or platform_machine != 'arm64'",
#   "onnx-asr[cpu,hub]; sys_platform != 'darwin' or platform_machine != 'arm64'",
#   "voxcpm>=2.0.3; sys_platform != 'darwin' or platform_machine != 'arm64'",
# ]
# ///
"""ZeroLux's voice: speech to text with the model the workspace chose, and each agent's own
voice, designed from a description and spoken with Pocket TTS."""

import base64
import io
import json
import shutil
import sys
import threading
import time
import uuid
from pathlib import Path

import soundfile as sf

from designing import Designer
from hearing import MODELS, Ears, decode
from speaking import MODELS as LANGUAGES
from speaking import Voices, sentences

# Each language with its name, the same for every client.
NAMES = {"it": "Italian", "en": "English"}
CHOICES = [{"const": code, "title": NAMES[code]} for code in LANGUAGES]
from zerolux import Extension

extension = Extension()
ears = Ears()


def heard(audio, rate: int, language: str) -> str:
    """What a take says, as Whisper hears it."""
    wav = io.BytesIO()
    sf.write(wav, audio, rate, format="WAV")
    return ears.hear(decode(wav.getvalue()), "whisper", [], gate=False)["text"]


designer = Designer(heard)
voices: Voices | None = None


def start() -> None:
    global voices
    voices = Voices(Path(extension.folder))


extension.started.append(start)


def warm() -> None:
    """The chosen transcription model, loaded as the voice starts and when the choice changes,
    not with the first recording: loading it takes seconds, up to a minute after hours idle."""
    model = extension.settings.get("transcription") or "whisper"

    def load() -> None:
        try:
            ears.ready(model)
        except Exception as error:  # noqa: BLE001
            print(f"The transcription model `{model}` did not load: {error}", file=sys.stderr)

    threading.Thread(target=load, name="warm", daemon=True).start()


extension.started.append(warm)
extension.changed.append(warm)


def actors() -> dict:
    return extension.ask("workspace.actors")


def vocabulary() -> list[str]:
    """Names the transcription must write right: the workspace's, its people's and agents'."""
    workspace = actors()
    return [workspace["name"], *(actor["name"] for actor in workspace["actors"])]


def agent(actor_id: str) -> dict:
    found = next((a for a in actors()["actors"] if a["id"] == actor_id and a["kind"] == "agent"), None)
    if found is None:
        raise ValueError("No such agent")
    return found


def described(actor_id: str) -> dict | None:
    path = voices.path(actor_id) / "voice.json"
    return json.loads(path.read_text()) if path.is_file() else None


@extension.action(
    "transcribe", "Transcribe", "Recording to text",
    input={"type": "object", "required": ["audio"], "properties": {
        "audio": {"type": "string", "description": "Base64 WebM, Ogg, MP4 or WAV"},
    }},
    seconds=300,
)
def transcribe(input: dict, caller: dict) -> dict:
    audio = decode(base64.b64decode(input["audio"]))
    model = extension.settings.get("transcription") or "whisper"
    return ears.hear(audio, model, vocabulary() if model == "whisper" else [])


@extension.action(
    "sentences", "Sentences", "Text split into sentences",
    input={"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
)
def split(input: dict, caller: dict) -> dict:
    return {"sentences": sentences(input["text"])}


@extension.action(
    "speak", "Speak", "Text in an agent's voice, as base64 WAV",
    input={"type": "object", "required": ["actor_id", "text"], "properties": {
        "actor_id": {"type": "string", "description": "Agent"},
        "text": {"type": "string", "minLength": 1, "maxLength": 2000},
        "language": {"type": "string", "oneOf": CHOICES},
    }},
    seconds=300,
)
def speak(input: dict, caller: dict) -> dict:
    voice = described(input["actor_id"])
    if voice is None:
        raise ValueError("This agent has no voice")
    said = voices.speak(input["actor_id"], input["text"], input.get("language"), voice["language"])
    return {**said, "audio": base64.b64encode(said["audio"]).decode()}


@extension.action("voices", "Voices", "Agents with a voice")
def listed(input: dict, caller: dict) -> dict:
    root = voices.path("x").parent
    found = []
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        voice = described(folder.name)
        if voice:
            found.append({"actor_id": folder.name, **voice})
    return {"voices": found}


@extension.action(
    "design", "Design a voice", "Three voice proposals from a description",
    input={"type": "object", "required": ["actor_id", "description"], "properties": {
        "actor_id": {"type": "string"},
        "description": {"type": "string", "minLength": 3, "maxLength": 500,
                        "description": "In English"},
        "language": {"type": "string", "oneOf": CHOICES, "default": "it"},
    }},
    effects="write", seconds=1800,
)
def design(input: dict, caller: dict) -> dict:
    name = agent(input["actor_id"])["name"]
    language = input.get("language") or "it"
    folder = voices.path(input["actor_id"]) / "proposals"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    proposals = []
    for audio, rate, text in designer.propose(name, input["description"], language):
        ident = uuid.uuid4().hex[:8]
        path = folder / f"{ident}.wav"
        sf.write(path, audio, rate)
        (folder / f"{ident}.json").write_text(json.dumps(
            {"text": text, "description": input["description"], "language": language}))
        proposals.append({"id": ident, "audio": base64.b64encode(path.read_bytes()).decode(),
                          "type": "audio/wav"})
    return {"proposals": proposals}


@extension.action(
    "choose", "Choose a voice", "Make a proposal the agent's voice",
    input={"type": "object", "required": ["actor_id", "proposal"], "properties": {
        "actor_id": {"type": "string"}, "proposal": {"type": "string", "pattern": "^[0-9a-f]{8}$"},
    }},
    effects="write", seconds=1800,
)
def choose(input: dict, caller: dict) -> dict:
    name = agent(input["actor_id"])["name"]
    folder = voices.path(input["actor_id"])
    proposal = folder / "proposals" / f"{input['proposal']}.wav"
    if not proposal.is_file():
        raise ValueError("No such proposal")
    about = json.loads(proposal.with_suffix(".json").read_text())
    audio, rate = designer.reference(name, str(proposal), about["text"], about["language"])
    voices.forget(input["actor_id"])
    for old in folder.glob("voice.*.safetensors"):
        old.unlink()
    sf.write(folder / "voice.wav", audio, rate)
    voice = {"description": about["description"], "language": about["language"], "created_at": int(time.time() * 1000)}
    (folder / "voice.json").write_text(json.dumps(voice))
    shutil.rmtree(folder / "proposals", ignore_errors=True)
    return {"voice": {"actor_id": input["actor_id"], **voice}}


@extension.action(
    "forget", "Remove the voice", "Remove the agent's voice",
    input={"type": "object", "required": ["actor_id"], "properties": {"actor_id": {"type": "string"}}},
    effects="destructive",
)
def forget(input: dict, caller: dict) -> dict:
    voices.forget(input["actor_id"])
    shutil.rmtree(voices.path(input["actor_id"]), ignore_errors=True)
    return {"forgotten": True}


if __name__ == "__main__":
    assert set(MODELS) == {"whisper", "parakeet", "qwen3"}
    extension.serve()
