# Voice

ZeroLux's voice is an [extension](extensions.md), `zerolux.voice`, in `marketplace/voice`, installed from the marketplace like any other. It turns speech into text with the model the workspace chooses, and gives each agent a voice of its own.

## Speech to text

The person chooses the engine and its model in Voice's section of the settings. None of the engines needs PyTorch.

| Engine         | Where it runs                                                                         | Acceleration                                 | Models                                            |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| whisper.cpp    | Its own `whisper-server`, started with the model and asked over HTTP on this computer | Metal on a Mac, CUDA or Vulkan, else the CPU | Whisper tiny to large-v3, GGML, Q5 or Q8          |
| faster-whisper | CTranslate2, in Voice's process                                                       | CUDA on an NVIDIA card, else INT8 on the CPU | Whisper tiny to large-v3, CTranslate2             |
| Parakeet       | ONNX Runtime through sherpa-onnx, in Voice's process                                  | The CPU                                      | Parakeet TDT 0.6B v3, INT8: 25 European languages |

The first time, Voice picks for the computer: Whisper large-v3 turbo with whisper.cpp where a graphics card runs it, with faster-whisper on an NVIDIA card, else Parakeet, and downloads it. Every model file is pinned to a revision and checked against its SHA-256 before it is used; downloads go on where they stopped, can be cancelled, and are kept in the extension's folder, `models/<engine>/<model>/`.

whisper.cpp runs the build for this computer's acceleration: a pack from ZeroLux's release (`whisper-server-<version>-<platform>-<backend>.zip`, installed from the settings into `models/runtimes/whisper.cpp/`), the one `ZEROLUX_WHISPER_SERVER` names, or Homebrew's `whisper-server`. On a graphics card that fails, the same recording is heard again on the CPU.

The model loads as Voice starts, and again when an app calls `prepare` as its microphone opens, so a recording does not wait for it. It stays loaded, or goes after 5, 15 or 60 minutes without use, as the person chooses; choosing another model lets the one before go.

A recording shorter than 0.3 seconds, or nearly silent, gives no text. whisper.cpp and faster-whisper hear only the speech Silero's voice activity detection finds, unless it is turned off. Whisper is given the names of the workspace, its people and its agents, and the words the person adds; Parakeet takes none.

## An agent's voice

1. **Design**: VoxCPM2 makes three voices from a description of the agent's voice, in English, each saying a greeting.
2. **Choose**: the chosen voice reads half a minute of text with every sound of its language, cut at a pause within 30 seconds. That recording is the voice's reference.
3. **Speak**: Pocket TTS speaks from the voice's print, made once from the reference: the large model, 5 decoding steps at temperature 0.5, on the CPU, in the language of each text. Italian numbers, times, percentages and amounts are written out first.

Each recording is the best of a few takes: among those the transcription model hears saying their text, the one with the quietest background.

Pocket clones voices with Kyutai's CC BY 4.0 weights from `lunahr/pocket-tts-ungated`, with pocket-tts 2.1.0: Italian and English.

## Actions

| Action                                                    | Result                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `transcribe {audio}`                                      | `{text, language, seconds}`; the recording in base64: WebM, Ogg, MP4 or WAV |
| `prepare`                                                 | Loads the chosen model in the background: its state                         |
| `settings`                                                | Engines, models with their downloads, accelerations, what is loaded         |
| `configure {model?, language?, vad?, keep?, vocabulary?}` | Changes the choice, and downloads the model chosen when it is missing       |
| `download`, `cancel`, `delete_model {model}`              | A model's download, stopped, or removed                                     |
| `install_runtime {backend}`                               | Downloads whisper.cpp built for this computer and that acceleration         |
| `load`, `unload`                                          | The chosen model, loaded now or let go                                      |
| `sentences {text}`                                        | `{sentences}`                                                               |
| `speak {actor_id, text, language?}`                       | `{audio, type, language, seconds}`: WAV in base64                           |
| `voices`                                                  | `{voices: [{actor_id, description, language, created_at}]}`                 |
| `design {actor_id, description, language?}`               | `{proposals: [{id, audio, type}]}`                                          |
| `choose {actor_id, proposal}`                             | `{voice}`                                                                   |
| `forget {actor_id}`                                       | Removes the agent's voice                                                   |

Clients read a message with `sentences`, then `speak` for each sentence, fetching the next while one plays.

## Running it

Its process part runs `uv run --script main.py`: the first start prepares a Python environment with its packages. Transcription models are kept in the extension's folder; the models that design and speak voices download the first time they are used, into the Hugging Face cache. Voices are kept in the extension's folder. Only a person changes the settings; agents and sessions transcribe.

`uv run --no-project --with numpy python -m unittest discover -s marketplace/voice` tests what it does without its models; `bun run test` runs it.
