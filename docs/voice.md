# Voice

ZeroLux's voice is an official [extension](extensions.md), `zerolux.voice`, in `extensions/voice`. It turns speech into text with the model the workspace chooses, and gives each agent a voice of its own.

## Speech to text

The `transcription` setting chooses the model:

| Model                  | On a Mac with Apple silicon | Elsewhere      | Notes                                           |
| ---------------------- | --------------------------- | -------------- | ----------------------------------------------- |
| Whisper large-v3 turbo | MLX                         | faster-whisper | The default. Writes the workspace's names right |
| Parakeet v3            | MLX                         | ONNX Runtime   | The fastest; writes nothing on noise            |
| Qwen3-ASR 0.6B         | MLX                         | Not available  | Steady on noise                                 |

Whisper is given the workspace's name and its people's and agents' names. A recording shorter than 0.3 seconds, or nearly silent, is no speech. On a short sound that is not speech Whisper writes a sentence anyway, so a recording up to 5 seconds keeps Whisper's text only if Parakeet, which writes nothing on noise, heard a word of it.

## An agent's voice

1. **Design**: VoxCPM2 makes three voices from a description of the agent's voice, in English, each saying a greeting.
2. **Choose**: the chosen voice reads half a minute of text with every sound of its language, cut at a pause within 30 seconds. That recording is the voice's reference.
3. **Speak**: Pocket TTS speaks from the voice's print, made once from the reference: the large model, 5 decoding steps at temperature 0.5, on the CPU, in the language of each text. Italian numbers, times, percentages and amounts are written out first.

Each recording is the best of a few takes: of those that say their text, as Whisper hears them back, the one whose voice stands farthest above its background.

Pocket clones voices with the CC BY 4.0 weights Kyutai keeps behind a form, from their public copy `lunahr/pocket-tts-ungated`, with pocket-tts 2.1.0. The copy has Italian and English.

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
