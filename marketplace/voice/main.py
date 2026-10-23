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
#   "faster-whisper>=1.2",
#   "sherpa-onnx>=1.12",
#   "mlx-audio>=0.5.8; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "voxcpm>=2.0.3; sys_platform != 'darwin' or platform_machine != 'arm64'",
# ]
# ///
"""ZeroLux's voice: speech to text with the engine and model the workspace chose (whisper.cpp,
faster-whisper or Parakeet, see `hearing`), and each agent's own
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

import catalog
from designing import Designer
from downloads import Downloads
from engines import EngineError
from hearing import Config, Ears, Runtimes, decode
from speaking import MODELS as LANGUAGES
from speaking import Voices, sentences

# Each language with its name, the same for every client.
NAMES = {"it": "Italian", "en": "English"}
CHOICES = [{"const": code, "title": NAMES[code]} for code in LANGUAGES]
from zerolux import Extension

extension = Extension()
ears: Ears | None = None
downloads: Downloads | None = None


def told() -> None:
    """Voice's settings read again: a model, a download or a runtime changed."""
    try:
        extension.publish("changed")
    except Exception:  # noqa: BLE001
        pass


def heard(audio, rate: int, language: str) -> str:
    """What a take says, as the chosen model hears it."""
    wav = io.BytesIO()
    sf.write(wav, audio, rate, format="WAV")
    return ears.hear(decode(wav.getvalue()), [], language)["text"]


designer = Designer(heard)
voices: Voices | None = None


def start() -> None:
    global voices, ears, downloads
    folder = Path(extension.folder)
    voices = Voices(folder)
    downloads = Downloads(folder / "models", told)
    ears = Ears(folder, downloads, Runtimes(downloads), told)
    # The kernel is asked once it has started Voice, not while it starts it.
    threading.Thread(target=restore, name="restore", daemon=True).start()
    threading.Thread(target=rest, name="rest", daemon=True).start()


def restore() -> None:
    """The workspace's choice, loaded; the first time, the model chosen for this computer
    downloads by itself."""
    kept = None
    for _ in range(30):
        try:
            kept = extension.get_value("transcription")
            break
        except Exception:  # noqa: BLE001
            time.sleep(1)
    try:
        ears.configure(Config.of(kept, ears.default()))
    except ValueError:
        pass
    model = catalog.model(ears.config.model)
    if downloads.ready(model.id, model.files):
        prepare_now()
    elif not kept:
        downloads.start(model.id, model.files, done=prepare_now)


def prepare_now() -> None:
    """Loads the chosen model in the background, so that the next recording finds it loaded."""

    def load() -> None:
        try:
            ears.ready()
        except Exception as error:  # noqa: BLE001
            print(f"The transcription model did not load: {error}", file=sys.stderr)

    threading.Thread(target=load, name="prepare", daemon=True).start()


def rest() -> None:
    while True:
        time.sleep(30)
        ears.idle()


extension.started.append(start)


def person(caller: dict) -> None:
    if caller.get("session_id") or caller.get("by"):
        raise PermissionError("Only a person changes Voice's settings")


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
    return ears.hear(audio, vocabulary())


@extension.action("prepare", "Prepare", "Load the transcription model, as a microphone opens")
def prepare(input: dict, caller: dict) -> dict:
    prepare_now()
    return ears.status()


def model_shown(model: catalog.Model) -> dict:
    return {"id": model.id, "engine": model.engine, "title": model.title, "variant": model.variant,
            "languages": model.languages, "size": model.size, "memory": model.memory,
            "licence": model.licence, "suggested": model.suggested, "vocabulary": model.vocabulary,
            **downloads.state(model.id, model.files)}


@extension.action("settings", "Settings", "Engines, models, what is loaded and how it is kept")
def settings(input: dict, caller: dict) -> dict:
    runtimes = ears.runtimes
    return {
        "config": ears.config.shown(),
        "status": ears.status(),
        "platform": runtimes.platform,
        "engines": [{"id": engine.id, "title": engine.title, "description": engine.description,
                     "backend": ears.backend(engine.id)} for engine in catalog.ENGINES],
        "runtimes": runtimes.offered(),
        "models": [model_shown(model) for model in catalog.MODELS],
        "languages": [{"value": key, "label": label} for key, label in catalog.LANGUAGES.items()],
    }


@extension.action(
    "configure", "Configure", "Choose the engine, model, language and how long the model stays loaded",
    input={"type": "object", "properties": {
        "model": {"type": "string"}, "language": {"type": "string"}, "vad": {"type": "boolean"},
        "keep": {"type": "integer", "minimum": 0, "maximum": 1440},
        "vocabulary": {"type": "array", "items": {"type": "string"}, "maxItems": 200},
    }},
    effects="write",
)
def configure(input: dict, caller: dict) -> dict:
    person(caller)
    changes = {key: input[key] for key in ("language", "vad", "keep") if key in input}
    if "vocabulary" in input:
        changes["vocabulary"] = tuple(word.strip() for word in input["vocabulary"] if word.strip())
    if "model" in input:
        model = catalog.model(input["model"])
        changes.update(engine=model.engine, model=model.id)
    if changes.get("language", "auto") not in catalog.LANGUAGES:
        raise ValueError("No such language")
    config = Config(**{**ears.config.__dict__, **changes})
    ears.configure(config)
    extension.set_value("transcription", config.shown())
    model = catalog.model(config.model)
    if downloads.ready(model.id, model.files):
        prepare_now()
    else:
        downloads.start(model.id, model.files, done=prepare_now)
    return settings({}, caller)


@extension.action(
    "download", "Download a model", "Download a transcription model",
    input={"type": "object", "required": ["model"], "properties": {"model": {"type": "string"}}},
    effects="write",
)
def download(input: dict, caller: dict) -> dict:
    person(caller)
    model = catalog.model(input["model"])
    downloads.start(model.id, model.files)
    return model_shown(model)


@extension.action(
    "cancel", "Cancel a download", "Stop a model's download",
    input={"type": "object", "required": ["model"], "properties": {"model": {"type": "string"}}},
    effects="write",
)
def cancel(input: dict, caller: dict) -> dict:
    person(caller)
    model = catalog.model(input["model"])
    downloads.cancel(model.id)
    return model_shown(model)


@extension.action(
    "delete_model", "Delete a model", "Remove a downloaded model from this computer",
    input={"type": "object", "required": ["model"], "properties": {"model": {"type": "string"}}},
    effects="destructive",
)
def delete_model(input: dict, caller: dict) -> dict:
    person(caller)
    model = catalog.model(input["model"])
    if model.id == ears.config.model:
        raise ValueError("Choose another model before deleting this one")
    downloads.delete(model.id)
    return model_shown(model)


@extension.action(
    "install_runtime", "Install whisper.cpp", "Download whisper.cpp built for this computer",
    input={"type": "object", "required": ["backend"], "properties": {"backend": {"type": "string"}}},
    effects="write",
)
def install_runtime(input: dict, caller: dict) -> dict:
    person(caller)
    ears.runtimes.install(input["backend"])
    return {"runtimes": ears.runtimes.offered()}


@extension.action("load", "Load", "Load the chosen model now", effects="write", seconds=300)
def load(input: dict, caller: dict) -> dict:
    person(caller)
    try:
        ears.ready()
    except EngineError as error:
        raise ValueError(str(error)) from error
    return ears.status()


@extension.action("unload", "Unload", "Free the memory the model takes", effects="write")
def unload(input: dict, caller: dict) -> dict:
    person(caller)
    ears.unload()
    return ears.status()


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
    extension.ui("settings", "voice", "Voice", {"kind": "native", "entry": "ui/native/settings.js"},
                 icon="audio-lines")
    extension.serve()
