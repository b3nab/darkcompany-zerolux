"""A ZeroLux extension's process part in Python: JSON-RPC 2.0 with the kernel over standard
input and output, one message per line. Actions run in threads, so a slow one never holds
the others; the kernel's answers to the extension's own requests arrive meanwhile."""

import json
import os
import sys
import threading
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable

# Standard output carries the protocol alone: whatever else writes there, from Python or from
# a library's own code, goes to standard error, which the kernel keeps as the extension's log.
_protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


class Extension:
    def __init__(self) -> None:
        self.actions: dict[str, dict] = {}
        self.settings: dict[str, Any] = {}
        self.folder = ""
        self.id = ""
        self.started: list[Callable[[], None]] = []
        self.changed: list[Callable[[], None]] = []
        self._write = threading.Lock()
        self._next = 0
        self._waiting: dict[int, Future] = {}
        self._pool = ThreadPoolExecutor(max_workers=8)

    def action(self, name: str, title: str, description: str, *, input: dict | None = None,
               effects: str = "read", seconds: int | None = None):
        """Declares one of its actions, run with its input and who asked."""
        def register(run: Callable[[dict, dict], Any]):
            self.actions[name] = {
                "spec": {"name": name, "title": title, "description": description,
                         "input": input or {"type": "object"}, "effects": effects,
                         **({"seconds": seconds} if seconds else {})},
                "run": run,
            }
            return run
        return register

    def ask(self, method: str, params: dict | None = None, timeout: float = 60) -> Any:
        """A request to the kernel, answered while actions keep running."""
        with self._write:
            self._next += 1
            ident = self._next
            future: Future = Future()
            self._waiting[ident] = future
        self._send({"id": ident, "method": method, "params": params or {}})
        return future.result(timeout=timeout)

    def log(self, message: str) -> None:
        self._send({"method": "log", "params": {"message": message}})

    def _send(self, message: dict) -> None:
        line = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False)
        with self._write:
            _protocol.write(line + "\n")
            _protocol.flush()

    def _answer(self, message: dict) -> None:
        ident, method, params = message["id"], message.get("method"), message.get("params") or {}
        try:
            if method == "initialize":
                self.id = params["extension"]["id"]
                self.folder = params.get("folder", "")
                self.settings = params.get("settings") or {}
                for start in self.started:
                    start()
                result = {"contributes": {"actions": [a["spec"] for a in self.actions.values()]}}
            elif method == "action.run":
                action = self.actions.get(params.get("action"))
                if action is None:
                    raise ValueError(f"No action `{params.get('action')}`")
                result = action["run"](params.get("input") or {}, params.get("caller") or {})
            else:
                raise ValueError(f"Unknown method `{method}`")
            self._send({"id": ident, "result": result})
        except Exception as error:  # noqa: BLE001 - the kernel hears every failure
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            self._send({"id": ident, "error": {"code": -32000, "message": str(error) or type(error).__name__}})

    def serve(self) -> None:
        """Answers the kernel until it closes the input or says to shut down."""
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" not in message and "id" in message:
                future = self._waiting.pop(message["id"], None)
                if future is not None:
                    if "error" in message:
                        future.set_exception(RuntimeError(message["error"].get("message", "The kernel refused")))
                    else:
                        future.set_result(message.get("result"))
                continue
            if "id" not in message:
                if message.get("method") == "shutdown":
                    break
                if message.get("method") == "settings":
                    self.settings = (message.get("params") or {}).get("settings") or {}
                    for change in self.changed:
                        self._pool.submit(change)
                continue
            self._pool.submit(self._answer, message)
        self._pool.shutdown(wait=False, cancel_futures=True)
