"""What Voice can hear with: its engines, the models each runs, and the native runtime
whisper.cpp needs. Every file is pinned to a revision, with its size and SHA-256, so a download
is checked before it is used."""

from dataclasses import dataclass

HF = "https://huggingface.co/{repo}/resolve/{revision}/{name}"


@dataclass(frozen=True)
class File:
    name: str
    url: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Model:
    id: str
    engine: str
    title: str
    # Its quantization or precision, as people compare them.
    variant: str
    # "multilingual", or the languages it hears.
    languages: str
    files: tuple[File, ...]
    licence: str
    # Memory it takes once loaded, about, in bytes.
    memory: int
    # Suggested where it fits: "gpu", "cpu" or "".
    suggested: str = ""
    # Takes the names it must write right.
    vocabulary: bool = True

    @property
    def size(self) -> int:
        return sum(file.size for file in self.files)


@dataclass(frozen=True)
class Engine:
    id: str
    title: str
    description: str
    runs: str


ENGINES = (
    Engine("whisper.cpp", "whisper.cpp", "Whisper in native code: Metal on a Mac, CUDA or Vulkan on a "
           "graphics card, else the processor", "native"),
    Engine("faster-whisper", "faster-whisper", "Whisper with CTranslate2: CUDA on an NVIDIA card, else "
           "the processor", "python"),
    Engine("parakeet", "Parakeet", "NVIDIA Parakeet v3 with ONNX Runtime: fast on the processor, 25 "
           "European languages", "python"),
)


def _hf(repo: str, revision: str, files: list[tuple[str, int, str]]) -> tuple[File, ...]:
    return tuple(File(name, HF.format(repo=repo, revision=revision, name=name), size, sha)
                 for name, size, sha in files)


_GGML = ("ggerganov/whisper.cpp", "5359861c739e955e79d9a303bcbc70fb988958b1")


def _ggml(id, title, variant, name, size, sha, memory, suggested=""):
    return Model(f"whisper.cpp/{id}", "whisper.cpp", title, variant, "multilingual",
                 _hf(*_GGML, [(name, size, sha)]), "MIT", memory, suggested)


# Shared by the multilingual faster-whisper models up to medium.
_TOKENS = [
    ("tokenizer.json", 2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
    ("vocabulary.txt", 459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
]
_TOKENS_V3 = [
    ("preprocessor_config.json", 340, "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"),
    ("vocabulary.json", 1068114, "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"),
]


def _ct2(id, title, repo, revision, files, memory, suggested=""):
    return Model(f"faster-whisper/{id}", "faster-whisper", title, "INT8 on the processor, FP16 on CUDA",
                 "multilingual", _hf(repo, revision, files), "MIT", memory, suggested)


MODELS = (
    _ggml("tiny", "Whisper tiny", "Q5_1", "ggml-tiny-q5_1.bin", 32152673,
          "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7", 150_000_000),
    _ggml("base", "Whisper base", "Q5_1", "ggml-base-q5_1.bin", 59707625,
          "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898", 250_000_000),
    _ggml("small", "Whisper small", "Q5_1", "ggml-small-q5_1.bin", 190085487,
          "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 500_000_000, "cpu"),
    _ggml("medium", "Whisper medium", "Q5_0", "ggml-medium-q5_0.bin", 539212467,
          "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f", 1_100_000_000),
    _ggml("large-v3-turbo-q5_0", "Whisper large-v3 turbo", "Q5_0", "ggml-large-v3-turbo-q5_0.bin",
          574041195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
          1_000_000_000, "gpu"),
    _ggml("large-v3-turbo-q8_0", "Whisper large-v3 turbo", "Q8_0", "ggml-large-v3-turbo-q8_0.bin",
          874188075, "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
          1_300_000_000),
    _ggml("large-v3-turbo", "Whisper large-v3 turbo", "FP16", "ggml-large-v3-turbo.bin",
          1624555275, "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
          2_100_000_000),
    _ggml("large-v3-q5_0", "Whisper large-v3", "Q5_0", "ggml-large-v3-q5_0.bin", 1081140203,
          "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1", 2_000_000_000),
    _ct2("tiny", "Whisper tiny", "Systran/faster-whisper-tiny", "d90ca5fe260221311c53c58e660288d3deb8d356",
         [("config.json", 2249, "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8"),
          ("model.bin", 75538270, "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"),
          *_TOKENS], 200_000_000),
    _ct2("base", "Whisper base", "Systran/faster-whisper-base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
         [("config.json", 2309, "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"),
          ("model.bin", 145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"),
          *_TOKENS], 300_000_000),
    _ct2("small", "Whisper small", "Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120",
         [("config.json", 2370, "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828"),
          ("model.bin", 483546902, "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"),
          *_TOKENS], 700_000_000, "cpu"),
    _ct2("medium", "Whisper medium", "Systran/faster-whisper-medium", "08e178d48790749d25932bbc082711ddcfdfbc4f",
         [("config.json", 2257, "3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807"),
          ("model.bin", 1527906378, "9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae"),
          *_TOKENS], 1_800_000_000),
    _ct2("large-v3-turbo", "Whisper large-v3 turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
         "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
         [("config.json", 2263, "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e"),
          ("model.bin", 1617884929, "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"),
          ("tokenizer.json", 2710337, "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd"),
          *_TOKENS_V3], 2_000_000_000, "gpu"),
    _ct2("large-v3", "Whisper large-v3", "Systran/faster-whisper-large-v3", "edaa852ec7e145841d8ffdb056a99866b5f0a478",
         [("config.json", 2394, "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9"),
          ("model.bin", 3087284237, "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"),
          ("tokenizer.json", 2480617, "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca"),
          *_TOKENS_V3], 3_500_000_000),
    Model("parakeet/tdt-0.6b-v3-int8", "parakeet", "Parakeet TDT 0.6B v3", "INT8",
          "25 European languages",
          _hf("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", [
              ("encoder.int8.onnx", 652184281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
              ("decoder.int8.onnx", 11845275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
              ("joiner.int8.onnx", 6355277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
              ("tokens.txt", 93939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
          ]), "CC BY 4.0", 1_000_000_000, "cpu", vocabulary=False),
)

# Silero's voice activity detection for whisper.cpp: what is not speech is not transcribed.
VAD = _hf("ggml-org/whisper-vad", "9ffd54a1e1ee413ddf265af9913beaf518d1639b", [
    ("ggml-silero-v6.2.0.bin", 885098, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"),
])


@dataclass(frozen=True)
class Runtime:
    """whisper.cpp's server for one computer and one kind of acceleration."""

    platform: str
    backend: str
    file: File | None = None


# The version of whisper.cpp Voice runs, built for each computer by ZeroLux's release workflow.
WHISPER_CPP = "1.9.5"
RUNTIME_RELEASE = (
    "https://github.com/b3nab/darkcompany-zerolux/releases/download/whisper.cpp-v{version}/{name}"
)
# Each pack's name and digest, once the release workflow has built it.
RUNTIMES: dict[tuple[str, str], tuple[int, str]] = {}
BACKENDS = {
    "macos-aarch64": ("metal", "cpu"),
    "linux-x86_64": ("cuda", "vulkan", "cpu"),
    "linux-aarch64": ("cpu",),
    "windows-x86_64": ("cuda", "vulkan", "cpu"),
}


def runtime(platform: str, backend: str) -> Runtime:
    name = f"whisper-server-{WHISPER_CPP}-{platform}-{backend}.zip"
    known = RUNTIMES.get((platform, backend))
    file = (File(name, RUNTIME_RELEASE.format(version=WHISPER_CPP, name=name), *known)
            if known else None)
    return Runtime(platform, backend, file)


def model(id: str) -> Model:
    for each in MODELS:
        if each.id == id:
            return each
    raise ValueError(f"No transcription model `{id}`")


LANGUAGES = {
    "auto": "Automatic", "it": "Italian", "en": "English", "fr": "French", "de": "German",
    "es": "Spanish", "pt": "Portuguese", "nl": "Dutch",
}
