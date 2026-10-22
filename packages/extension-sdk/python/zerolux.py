"""The SDK of ZeroLux extensions' process parts, in Python: JSON-RPC 2.0 with the kernel over
standard input and output, one message per line. An extension declares its actions, the
extension points it opens and those of others it implements, the events it publishes and hears,
and its triggers; `serve` runs it as the kernel starts it. Actions run in threads, so a slow
one never holds the others; the kernel's answers to the extension's own requests arrive
meanwhile. One file, with no dependencies: `zerolux ext new` puts it beside the extension."""

import json
import os
import sys
import threading
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, TextIO

# Standard output carries the protocol alone: whatever else writes there, from Python or from
# a library's own code, goes to standard error, which the kernel keeps as the extension's log.
# Imported by a test, the protocol stays where `serve` is told.
_protocol: TextIO | None = None


def _take_stdout() -> TextIO:
    global _protocol
    if _protocol is None:
        _protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
        os.dup2(2, 1)
        sys.stdout = sys.stderr
    return _protocol


if __name__ != "__main__" and os.environ.get("ZEROLUX_EXTENSION"):
    _take_stdout()


class Extension:
    def __init__(self) -> None:
        self.actions: dict[str, dict] = {}
        self.points: dict[str, dict] = {}
        self.implementations: list[dict] = []
        self.events: dict[str, str] = {}
        self.handlers: dict[str, Callable[[Any], None]] = {}
        self.triggers: list[dict] = []
        self.pieces: list[dict] = []
        self.settings: dict[str, Any] = {}
        self.folder = ""
        # The workspace's storage area: the files its people and agents keep.
        self.storage_area = ""
        self.id = ""
        self.version = ""
        # Run once the kernel has started it, and after its settings changed.
        self.started: list[Callable[[], None]] = []
        self.changed: list[Callable[[], None]] = []
        self._write = threading.Lock()
        self._next = 0
        self._waiting: dict[int, Future] = {}
        self._pool = ThreadPoolExecutor(max_workers=8)
        self._out: TextIO | None = None

    # What it brings.

    def action(self, name: str, title: str, description: str, *, input: dict | None = None,
               output: dict | None = None, effects: str = "read", seconds: int | None = None):
        """Declares one of its actions, run with its input and who asked (`actor_id`,
        `session_id`, `by`). `effects` is read, write or destructive; `seconds`, how long it may
        take when longer than a minute, up to 30 minutes."""
        def register(run: Callable[[dict, dict], Any]):
            self.actions[name] = {
                "spec": {"name": name, "title": title, "description": description,
                         "input": input or {"type": "object"}, "effects": effects,
                         **({"output": output} if output else {}),
                         **({"seconds": seconds} if seconds else {})},
                "run": run,
            }
            return run
        return register

    def point(self, name: str, version: int, operations: dict[str, dict], description: str = "") -> None:
        """Opens an extension point: the contract its implementations follow, each operation
        with its `description`, `input` and `output` schemas."""
        self.points[name] = {
            "name": name, "version": version, "description": description,
            "operations": [{"name": op, "description": spec.get("description", ""),
                            "input": spec.get("input") or {"type": "object"},
                            **({"output": spec["output"]} if spec.get("output") else {})}
                           for op, spec in operations.items()],
        }

    def implement(self, point: str, name: str, title: str,
                  operations: dict[str, Callable[[dict], Any]]) -> None:
        """Implements another extension's point, `publisher.extension/point@version`."""
        self.implementations.append({"point": point, "name": name, "title": title,
                                     "operations": operations})

    def event(self, name: str, description: str = "") -> None:
        """Declares an event it publishes, named under it."""
        self.events[name] = description

    def on(self, event: str):
        """Hears an event, `publisher.extension/event`, with its payload."""
        def register(handler: Callable[[Any], None]):
            self.handlers[event] = handler
            return handler
        return register

    def trigger(self, on: str, action: str) -> None:
        """Runs one of its actions on `event:<publisher.extension/event>` or `schedule:<cron>`."""
        self.triggers.append({"on": on, "action": action})

    def ui(self, space: str, name: str, title: str, view: dict, icon: str | None = None) -> None:
        """Shows a piece of its interface in one of the clients' spaces (`page`, `session`,
        `chat`, `message` or `settings`), drawn as `view` says: `{"kind": "native"}`,
        `{"kind": "described", "action": …, "refresh_on": […]}`, `{"kind": "remote", "action": …}`,
        `{"kind": "web", "entry": "ui/…"}` or, on a message, `{"kind": "action", "action": …}`."""
        self.pieces.append({"space": space, "name": name, "title": title, "view": view,
                            **({"icon": icon} if icon else {})})

    def contributes(self) -> dict:
        return {
            "actions": [action["spec"] for action in self.actions.values()],
            "points": list(self.points.values()),
            "implements": [{"point": i["point"], "name": i["name"], "title": i["title"]}
                           for i in self.implementations],
            "events": [{"name": name, "description": description}
                       for name, description in self.events.items()],
            "subscribes": list(self.handlers),
            "triggers": self.triggers,
            "ui": self.pieces,
        }

    # What it asks the kernel.

    def ask(self, method: str, params: dict | None = None, timeout: float = 60) -> Any:
        """A request to the kernel, answered while actions keep running."""
        with self._write:
            self._next += 1
            ident = self._next
            future: Future = Future()
            self._waiting[ident] = future
        self._send({"id": ident, "method": method, "params": params or {}})
        return future.result(timeout=timeout)

    def secrets(self) -> dict:
        """Its settings with its secrets."""
        return self.ask("settings.get")["settings"]

    def get_value(self, key: str) -> Any:
        """A value it keeps in the workspace, or None."""
        return self.ask("values.get", {"key": key}).get("value")

    def set_value(self, key: str, value: Any) -> None:
        self.ask("values.set", {"key": key, "value": value})

    def delete_value(self, key: str) -> None:
        self.ask("values.set", {"key": key, "value": None})

    def list_values(self, prefix: str = "") -> list[str]:
        return self.ask("values.list", {"prefix": prefix})["keys"]

    def secret(self, name: str) -> Any:
        """One of the secrets it keeps itself, or None: encrypted with the kernel's key and
        never shown to people's clients."""
        return self.ask("secrets.get", {"name": name}).get("value")

    def set_secret(self, name: str, value: Any) -> None:
        """Keeps a secret; None removes it."""
        self.ask("secrets.set", {"name": name, "value": value})

    def secret_names(self, prefix: str = "") -> list[str]:
        return self.ask("secrets.list", {"prefix": prefix})["names"]

    def oauth_start(self, request: dict) -> dict:
        """Starts a sign-in to another service with OAuth: `{url, redirect_uri}`, the address
        the person opens. The service comes back to the kernel, which keeps the tokens in
        `request["secret"]` and sends the `zerolux/signed_in` event, `{secret, ok, error?}`."""
        return self.ask("oauth.start", request)

    def oauth_token(self, secret: str) -> dict:
        """A valid access token from a secret a sign-in filled, renewed when due."""
        return self.ask("oauth.token", {"secret": secret})

    def workspace(self) -> dict:
        """The workspace's name, and its people and agents."""
        return self.ask("workspace.actors")

    def publish(self, event: str, payload: Any = None) -> None:
        """Publishes one of its events."""
        self.ask("events.publish", {"name": event, "payload": payload})

    def run(self, extension: str, action: str, input: dict | None = None) -> Any:
        """Runs another extension's action."""
        return self.ask("actions.run", {"extension": extension, "action": action,
                                        "input": input or {}})["result"]

    def implementations_of(self, point: str) -> list[dict]:
        """Who implements a point: each `{extension, name, title}`."""
        return self.ask("points.implementations", {"point": point})["implementations"]

    def call(self, point: str, implementation: str, operation: str, input: dict | None = None) -> Any:
        """Calls an operation of one implementation of a point."""
        return self.ask("points.call", {"point": point, "implementation": implementation,
                                        "operation": operation, "input": input or {}})["result"]

    def tell_agent(self, actor_id: str, text: str) -> str:
        """An agent hears `text` in its newest running session, as input that waits for its
        turn: that session's id. Refused when the agent has none running."""
        return self.ask("agents.tell", {"actor_id": actor_id, "text": text})["session_id"]

    def update_view(self, name: str, context: dict, tree: dict) -> None:
        """A new tree for one of its `remote` views, shown with `context`."""
        self.ask("views.update", {"name": name, "context": context, "tree": tree})

    def log(self, message: str) -> None:
        self._send({"method": "log", "params": {"message": message}})

    # The protocol.

    def _send(self, message: dict) -> None:
        line = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False)
        with self._write:
            out = self._out or _take_stdout()
            out.write(line + "\n")
            out.flush()

    def _answer(self, message: dict) -> None:
        ident, method, params = message["id"], message.get("method"), message.get("params") or {}
        try:
            if method == "initialize":
                self.id = params["extension"]["id"]
                self.version = params["extension"].get("version", "")
                self.folder = params.get("folder", "")
                self.storage_area = params.get("storage", "")
                self.settings = params.get("settings") or {}
                for start in self.started:
                    start()
                result = {"contributes": self.contributes()}
            elif method == "action.run":
                action = self.actions.get(params.get("action"))
                if action is None:
                    raise ValueError(f"No action `{params.get('action')}`")
                result = action["run"](params.get("input") or {}, params.get("caller") or {})
            elif method == "point.call":
                found = next((i for i in self.implementations
                              if i["point"] == params.get("point")
                              and i["name"] == params.get("implementation")), None)
                operation = found and found["operations"].get(params.get("operation"))
                if not operation:
                    raise ValueError(f"No implementation of {params.get('point')} `{params.get('operation')}`")
                result = operation(params.get("input") or {})
            else:
                raise ValueError(f"Unknown method `{method}`")
            self._send({"id": ident, "result": result})
        except Exception as error:  # noqa: BLE001 - the kernel hears every failure
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            self._send({"id": ident, "error": {"code": -32000, "message": str(error) or type(error).__name__}})

    def _heard(self, event: str, payload: Any) -> None:
        try:
            self.handlers[event](payload)
        except Exception as error:  # noqa: BLE001 - a failed handler is logged, not fatal
            self.log(f"Event {event} failed: {error}")

    def serve(self, input: TextIO | None = None, output: TextIO | None = None) -> None:
        """Answers the kernel until it closes the input or says to shut down. Tests pass their
        own streams."""
        self._out = output
        for line in input or sys.stdin:
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
                method, params = message.get("method"), message.get("params") or {}
                if method == "shutdown":
                    break
                if method == "settings":
                    self.settings = params.get("settings") or {}
                    for change in self.changed:
                        self._pool.submit(change)
                if method == "event" and params.get("name") in self.handlers:
                    self._pool.submit(self._heard, params["name"], params.get("payload"))
                continue
            self._pool.submit(self._answer, message)
        self._pool.shutdown(wait=False, cancel_futures=True)
