"""Downloads of models and runtimes into Voice's folder: resumed where they stopped, checked
against their digests, and ready only once every file is; one job per thing, cancellable, with
its progress for the settings to show."""

import hashlib
import json
import shutil
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from catalog import File

CHUNK = 1 << 20
MARK = ".ready.json"


@dataclass
class Job:
    total: int
    done: int = 0
    started: float = field(default_factory=time.monotonic)
    error: str | None = None
    cancelled: bool = False
    finished: bool = False

    def shown(self) -> dict:
        elapsed = max(time.monotonic() - self.started, 0.001)
        return {"done": self.done, "total": self.total,
                "speed": int(self.done / elapsed) if not self.finished else 0,
                "error": self.error}


class Cancelled(Exception):
    pass


class Downloads:
    def __init__(self, root: Path, changed: Callable[[], None] = lambda: None,
                 open_url: Callable = urllib.request.urlopen) -> None:
        self.root = root
        self.changed = changed
        self.open_url = open_url
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self._told = 0.0

    def folder(self, key: str) -> Path:
        return self.root / key

    def ready(self, key: str, files: Iterable[File]) -> bool:
        """Whether every file is there as its digest says: checked as it came."""
        folder = self.folder(key)
        mark = folder / MARK
        if not mark.is_file():
            return False
        try:
            kept = json.loads(mark.read_text())
        except ValueError:
            return False
        return all(kept.get(file.name) == file.sha256 and (folder / file.name).is_file()
                   and (folder / file.name).stat().st_size == file.size for file in files)

    def state(self, key: str, files: Iterable[File]) -> dict:
        files = list(files)
        job = self.jobs.get(key)
        if job and not job.finished:
            return {"state": "downloading", **job.shown()}
        if self.ready(key, files):
            return {"state": "ready"}
        if job and job.error:
            return {"state": "failed", "error": job.error}
        return {"state": "absent"}

    def start(self, key: str, files: Iterable[File], then: Callable[[Path], None] | None = None,
              done: Callable[[], None] | None = None) -> None:
        """Downloads the files into the key's folder, in the background. `then` runs on the
        folder once they all are there, before it is ready; `done`, once it is."""
        files = list(files)
        with self.lock:
            running = self.jobs.get(key)
            if running and not running.finished:
                return
            job = Job(total=sum(file.size for file in files))
            self.jobs[key] = job
        threading.Thread(target=self._run, args=(key, files, job, then, done), daemon=True,
                         name=f"download {key}").start()
        self.changed()

    def wait(self, key: str, timeout: float | None = None) -> Job | None:
        """Waits for a job to end: for tests and for what needs the files now."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            job = self.jobs.get(key)
            if job is None or job.finished:
                return job
            if deadline is not None and time.monotonic() > deadline:
                return job
            time.sleep(0.02)

    def cancel(self, key: str) -> None:
        job = self.jobs.get(key)
        if job and not job.finished:
            job.cancelled = True

    def delete(self, key: str) -> None:
        self.cancel(key)
        self.wait(key, 10)
        shutil.rmtree(self.folder(key), ignore_errors=True)
        self.jobs.pop(key, None)
        self.changed()

    def _tell(self, force: bool = False) -> None:
        # Progress is told twice a second at most.
        now = time.monotonic()
        if force or now - self._told > 0.5:
            self._told = now
            self.changed()

    def _run(self, key: str, files: list[File], job: Job, then, done) -> None:
        folder = self.folder(key)
        try:
            folder.mkdir(parents=True, exist_ok=True)
            (folder / MARK).unlink(missing_ok=True)
            kept = {}
            for file in files:
                self._file(folder, file, job)
                kept[file.name] = file.sha256
            if then:
                then(folder)
            (folder / MARK).write_text(json.dumps(kept))
            job.finished = True
            if done:
                done()
        except Cancelled:
            job.error = None
            shutil.rmtree(folder, ignore_errors=True)
        except Exception as error:  # noqa: BLE001
            job.error = f"{error}"
        finally:
            job.finished = True
            self._tell(force=True)

    def _file(self, folder: Path, file: File, job: Job) -> None:
        target = folder / file.name
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")
        digest = hashlib.sha256()
        if target.is_file() and target.stat().st_size == file.size:
            part.unlink(missing_ok=True)
            target.rename(part)
        have = part.stat().st_size if part.is_file() else 0
        if have > file.size:
            part.unlink()
            have = 0
        if have:
            with part.open("rb") as kept:
                for chunk in iter(lambda: kept.read(CHUNK), b""):
                    digest.update(chunk)
        job.done += have
        if have < file.size:
            request = urllib.request.Request(file.url, headers={"User-Agent": "ZeroLux Voice"})
            if have:
                request.add_header("Range", f"bytes={have}-")
            with self.open_url(request, timeout=60) as response, part.open("ab" if have else "wb") as out:
                if have and getattr(response, "status", 206) != 206:
                    # The server sent it all again: start over.
                    out.truncate(0)
                    digest = hashlib.sha256()
                    job.done -= have
                for chunk in iter(lambda: response.read(CHUNK), b""):
                    if job.cancelled:
                        raise Cancelled()
                    out.write(chunk)
                    digest.update(chunk)
                    job.done += len(chunk)
                    self._tell()
        if part.stat().st_size != file.size or digest.hexdigest() != file.sha256:
            part.unlink(missing_ok=True)
            raise ValueError(f"{file.name} did not arrive as published")
        part.rename(target)
