# Voice

ZeroLux's voice is an official [extension](extensions.md), `zerolux.voice`, in `extensions/voice`. It turns speech into text with the model the workspace chooses, and gives each agent a voice of its own.

## Speech to text

The `transcription` setting chooses the model:

| Model                  | On a Mac with Apple silicon | Elsewhere      | Notes                                           |
| ---------------------- | --------------------------- | -------------- | ----------------------------------------------- |
| Whisper large-v3 turbo | MLX                         | faster-whisper | The default. Writes the workspace's names right |
| Parakeet v3            | MLX                         | ONNX Runtime   | The fastest; writes nothing on noise            |
| Qwen3-ASR 0.6B         | MLX                         | Not available  | Steady on noise                                 |

Whisper is given the workspace's name and its people's and agents' names. A recording shorter than 0.3 seconds, or nearly silent, is no speech: Whisper would invent a sentence there.

## An agent's voice

1. **Design**: VoxCPM2 makes three voices from a description of the agent, in English, each saying a greeting.
2. **Choose**: the chosen voice reads half a minute of text with every sound of its language. That recording is the voice's reference.
3. **Speak**: Pocket TTS speaks from the reference, on the CPU, in the language of each text (Italian, English, French, German, Spanish, Portuguese or Dutch). Times, numbers and percentages are written out first.

Pocket's voice cloning uses the CC BY 4.0 weights Kyutai published, from the public copy `lunahr/pocket-tts-ungated`.

## Actions

| Action                                      | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `transcribe {audio}`                        | `{text, language, seconds}`; the recording in base64: WebM, Ogg, MP4 or WAV |
| `sentences {text}`                          | `{sentences}`: the pieces a voice says one after another                    |
| `speak {actor_id, text, language?}`         | `{audio, type, language, seconds}`: WAV in base64                           |
| `voices`                                    | `{voices: [{actor_id, description, language, created_at}]}`                 |
| `design {actor_id, description, language?}` | `{proposals: [{id, audio, type}]}`                                          |
| `choose {actor_id, proposal}`               | `{voice}`                                                                   |
| `forget {actor_id}`                         | The agent has no voice again                                                |

Clients read a message aloud sentence by sentence: `sentences`, then `speak` for each, playing one while the next is made.

## Running it

Its process part runs `uv run --script main.py`: the first start prepares a Python environment with its packages, and each model downloads the first time it is used, into the Hugging Face cache. Voices are kept in the extension's folder.
