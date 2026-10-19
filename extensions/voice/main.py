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
import json
import shutil
import time
import uuid
from pathlib import Path

import soundfile as sf

from designing import Designer
from hearing import MODELS, Ears, decode
from speaking import LANGUAGES, Voices, sentences
from zerolux import Extension

extension = Extension()
ears = Ears()
designer = Designer()
voices: Voices | None = None


def start() -> None:
    global voices
    voices = Voices(Path(extension.folder))


extension.started.append(start)


def actors() -> dict:
    return extension.ask("workspace.actors")


def vocabulary() -> list[str]:
    """Names the transcription must write right: the workspace's, its people's and agents'."""
    workspace = actors()
    return [workspace["name"], *(actor["name"] for actor in workspace["actors"])]


def agent(actor_id: str) -> dict:
    found = next((a for a in actors()["actors"] if a["id"] == actor_id and a["kind"] == "agent"), None)
    if found is None:
        raise ValueError("No agent of this workspace has this ID")
    return found


def described(actor_id: str) -> dict | None:
    path = voices.path(actor_id) / "voice.json"
    return json.loads(path.read_text()) if path.is_file() else None


@extension.action(
    "transcribe", "Transcribe", "What was said in a recording, as text, with the workspace's names written right",
    input={"type": "object", "required": ["audio"], "properties": {
        "audio": {"type": "string", "description": "The recording, in base64: WebM, Ogg, MP4 or WAV"},
    }},
    seconds=300,
)
def transcribe(input: dict, caller: dict) -> dict:
    audio = decode(base64.b64decode(input["audio"]))
    model = extension.settings.get("transcription") or "whisper"
    return ears.hear(audio, model, vocabulary() if model == "whisper" else [])


@extension.action(
    "sentences", "Sentences", "A text in the sentences a voice says one after another",
    input={"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
)
def split(input: dict, caller: dict) -> dict:
    return {"sentences": sentences(input["text"])}


@extension.action(
    "speak", "Speak", "A sentence or a few, said by an agent with its own voice, as WAV in base64",
    input={"type": "object", "required": ["actor_id", "text"], "properties": {
        "actor_id": {"type": "string", "description": "The agent whose voice it is"},
        "text": {"type": "string", "minLength": 1, "maxLength": 2000},
        "language": {"type": "string", "enum": list(LANGUAGES), "description": "Otherwise the text's own"},
    }},
    seconds=300,
)
def speak(input: dict, caller: dict) -> dict:
    voice = described(input["actor_id"])
    if voice is None:
        raise ValueError("This agent has no voice yet: create one first")
    said = voices.speak(input["actor_id"], input["text"], input.get("language"), voice["language"])
    return {**said, "audio": base64.b64encode(said["audio"]).decode()}


@extension.action("voices", "Voices", "The agents that have a voice, and how each was described")
def listed(input: dict, caller: dict) -> dict:
    root = voices.path("x").parent
    found = []
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        voice = described(folder.name)
        if voice:
            found.append({"actor_id": folder.name, **voice})
    return {"voices": found}


@extension.action(
    "design", "Design a voice",
    "Three voices for an agent from a description of it, in English, each saying a greeting",
    input={"type": "object", "required": ["actor_id", "description"], "properties": {
        "actor_id": {"type": "string"},
        "description": {"type": "string", "minLength": 3, "maxLength": 500,
                        "description": "In English, e.g. a warm, calm adult voice with a slight rasp"},
        "language": {"type": "string", "enum": list(LANGUAGES), "default": "it"},
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
    "choose", "Choose a voice",
    "One of the proposals becomes the agent's voice: it reads a text with every sound of its language",
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
        raise ValueError("No such proposal: design the voice again")
    about = json.loads(proposal.with_suffix(".json").read_text())
    audio, rate = designer.reference(name, str(proposal), about["text"], about["language"])
    voices.forget(input["actor_id"])
    for old in folder.glob("print.*.safetensors"):
        old.unlink()
    sf.write(folder / "reference.wav", audio, rate)
    voice = {"description": about["description"], "language": about["language"], "created_at": int(time.time() * 1000)}
    (folder / "voice.json").write_text(json.dumps(voice))
    shutil.rmtree(folder / "proposals", ignore_errors=True)
    return {"voice": {"actor_id": input["actor_id"], **voice}}


@extension.action(
    "forget", "Forget a voice", "The agent goes back to having no voice",
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
