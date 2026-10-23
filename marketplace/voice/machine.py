"""The computer Voice runs on: its platform, and the acceleration it offers, best first."""

import ctypes.util
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def platform_key() -> str:
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "amd64": "x86_64", "x86_64": "x86_64"}.get(machine, machine)
    return f"{system}-{arch}"


def nvidia() -> bool:
    """An NVIDIA card with its driver."""
    tool = shutil.which("nvidia-smi")
    if not tool:
        return False
    try:
        found = subprocess.run([tool, "-L"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return found.returncode == 0 and "GPU" in found.stdout


def vulkan() -> bool:
    """A Vulkan driver: AMD, Intel and NVIDIA cards on Windows and Linux."""
    if sys.platform == "win32":
        return (Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "vulkan-1.dll").is_file()
    if sys.platform.startswith("linux"):
        return ctypes.util.find_library("vulkan") is not None
    return False


def backends(key: str | None = None, probe_nvidia=nvidia, probe_vulkan=vulkan) -> list[str]:
    """The kinds of acceleration whisper.cpp can use here, best first; the processor last."""
    key = key or platform_key()
    if key == "macos-aarch64":
        return ["metal", "cpu"]
    found = []
    if key.endswith("x86_64") and not key.startswith("macos") and probe_nvidia():
        found.append("cuda")
    if not key.startswith("macos") and probe_vulkan():
        found.append("vulkan")
    return [*found, "cpu"]


def cuda_devices() -> int:
    """NVIDIA cards CTranslate2 can use."""
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count()
    except Exception:  # noqa: BLE001
        return 0


def threads() -> int:
    return max(1, min(8, (os.cpu_count() or 4) - 1))
