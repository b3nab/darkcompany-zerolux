# Voice

ZeroLux's voice is an official [extension](extensions.md), `zerolux.voice`, in `extensions/voice`. It turns speech into text with the model the workspace chooses, and gives each agent a voice of its own.

## Speech to text

The `transcription` setting chooses the model:

| Model                            | On a Mac with Apple silicon | Elsewhere      |
| -------------------------------- | --------------------------- | -------------- |
| Whisper large-v3 turbo (default) | MLX                         | faster-whisper |
| Parakeet v3                      | MLX                         | ONNX Runtime   |
| Qwen3-ASR 0.6B                   | MLX                         | Not available  |

Whisper is given the names of the workspace, its people and its agents. A recording shorter than 0.3 seconds, or nearly silent, gives no text. Up to 5 seconds, Whisper's text is kept only if Parakeet heard a word of it.

## An agent's voice

1. **Design**: VoxCPM2 makes three voices from a description of the agent's voice, in English, each saying a greeting.
2. **Choose**: the chosen voice reads half a minute of text with every sound of its language, cut at a pause within 30 seconds. That recording is the voice's reference.
3. **Speak**: Pocket TTS speaks from the voice's print, made once from the reference: the large model, 5 decoding steps at temperature 0.5, on the CPU, in the language of each text. Italian numbers, times, percentages and amounts are written out first.

Each recording is the best of a few takes: among those Whisper hears saying their text, the one with the quietest background.

Pocket clones voices with Kyutai's CC BY 4.0 weights from `lunahr/pocket-tts-ungated`, with pocket-tts 2.1.0: Italian and English.

## Actions

| Action                                      | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `transcribe {audio}`                        | `{text, language, seconds}`; the recording in base64: WebM, Ogg, MP4 or WAV |
| `sentences {text}`                          | `{sentences}`                                                               |
| `speak {actor_id, text, language?}`         | `{audio, type, language, seconds}`: WAV in base64                           |
| `voices`                                    | `{voices: [{actor_id, description, language, created_at}]}`                 |
| `design {actor_id, description, language?}` | `{proposals: [{id, audio, type}]}`                                          |
| `choose {actor_id, proposal}`               | `{voice}`                                                                   |
| `forget {actor_id}`                         | Removes the agent's voice                                                   |

Clients read a message with `sentences`, then `speak` for each sentence, fetching the next while one plays.

## Running it

Its process part runs `uv run --script main.py`: the first start prepares a Python environment with its packages, and each model downloads the first time it is used, into the Hugging Face cache. Voices are kept in the extension's folder.

`uv run --no-project --with numpy python -m unittest discover -s extensions/voice` tests what it does without its models; `bun run test` runs it.
