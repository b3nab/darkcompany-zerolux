"""The Python SDK as the kernel meets it: initialize, actions, points, events and the
extension's own requests, over a pipe."""

import io
import json
import os
import queue
import threading
import time
import unittest
from pathlib import Path

import zerolux

HERE = Path(__file__).parent


class Kernel:
    """Plays the kernel: writes requests into the extension and reads what it says."""

    def __init__(self, extension: zerolux.Extension) -> None:
        read, self._write = os.pipe()
        self._to = os.fdopen(self._write, "w", buffering=1)
        self.said: queue.Queue = queue.Queue()
        out = Lines(self.said)
        self.thread = threading.Thread(target=extension.serve,
                                       args=(os.fdopen(read), out), daemon=True)
        self.thread.start()

    def send(self, message: dict) -> None:
        self._to.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")

    def next(self) -> dict:
        return self.said.get(timeout=5)

    def answer(self, ident: int) -> dict:
        while True:
            message = self.next()
            if message.get("id") == ident and "method" not in message:
                return message

    def close(self) -> None:
        self.send({"method": "shutdown"})
        self._to.close()
        self.thread.join(timeout=5)


class Lines(io.TextIOBase):
    def __init__(self, said: queue.Queue) -> None:
        self.said = said

    def write(self, text: str) -> int:
        for line in text.splitlines():
            if line.strip():
                self.said.put(json.loads(line))
        return len(text)


def notes() -> zerolux.Extension:
    ext = zerolux.Extension()
    ext.point("stores", 1, {"put": {"input": {"type": "object"}}}, "Where notes are kept")
    ext.implement("zerolux.notes/stores@1", "memory", "Memory",
                  {"put": lambda input: {"kept": input["key"]}})
    ext.event("saved", "A note was saved")
    ext.trigger("schedule:0 * * * *", "save")
    heard = []

    @ext.on("zerolux.other/changed")
    def changed(payload):
        heard.append(payload)

    @ext.action("save", "Save a note", "Keeps a note", effects="write")
    def save(input, caller):
        ext.publish("saved", {"key": input["key"]})
        return {"by": caller.get("actor_id"), "value": ext.get_value(input["key"])}

    ext.heard = heard  # type: ignore[attr-defined]
    return ext


class SDK(unittest.TestCase):
    def test_initialize_says_what_it_brings(self):
        ext = notes()
        kernel = Kernel(ext)
        kernel.send({"id": 1, "method": "initialize", "params": {
            "extension": {"id": "zerolux.notes", "version": "1.0.0"},
            "settings": {"tone": "warm"}, "folder": "/tmp/notes"}})
        brought = kernel.answer(1)["result"]["contributes"]
        self.assertEqual([a["name"] for a in brought["actions"]], ["save"])
        self.assertEqual(brought["actions"][0]["effects"], "write")
        self.assertEqual(brought["points"][0]["operations"][0]["name"], "put")
        self.assertEqual(brought["implements"], [{"point": "zerolux.notes/stores@1",
                                                  "name": "memory", "title": "Memory"}])
        self.assertEqual(brought["events"], [{"name": "saved", "description": "A note was saved"}])
        self.assertEqual(brought["subscribes"], ["zerolux.other/changed"])
        self.assertEqual(brought["triggers"], [{"on": "schedule:0 * * * *", "action": "save"}])
        self.assertEqual((ext.id, ext.folder, ext.settings), ("zerolux.notes", "/tmp/notes", {"tone": "warm"}))
        kernel.close()

    def test_an_action_asks_the_kernel_while_it_runs(self):
        kernel = Kernel(notes())
        kernel.send({"id": 7, "method": "action.run", "params": {
            "action": "save", "input": {"key": "k"}, "caller": {"actor_id": "a1"}}})
        published = kernel.next()
        self.assertEqual(published["method"], "events.publish")
        self.assertEqual(published["params"], {"name": "saved", "payload": {"key": "k"}})
        kernel.send({"id": published["id"], "result": {}})
        asked = kernel.next()
        self.assertEqual((asked["method"], asked["params"]), ("values.get", {"key": "k"}))
        kernel.send({"id": asked["id"], "result": {"value": "kept"}})
        self.assertEqual(kernel.answer(7)["result"], {"by": "a1", "value": "kept"})
        kernel.close()

    def test_points_events_and_failures(self):
        ext = notes()
        kernel = Kernel(ext)
        kernel.send({"id": 2, "method": "point.call", "params": {
            "point": "zerolux.notes/stores@1", "implementation": "memory",
            "operation": "put", "input": {"key": "k"}}})
        self.assertEqual(kernel.answer(2)["result"], {"kept": "k"})
        kernel.send({"id": 3, "method": "action.run", "params": {"action": "missing"}})
        self.assertEqual(kernel.answer(3)["error"]["code"], -32000)
        kernel.send({"method": "event", "params": {"name": "zerolux.other/changed", "payload": 5}})
        for _ in range(100):
            if ext.heard:  # type: ignore[attr-defined]
                break
            time.sleep(0.02)
        self.assertEqual(ext.heard, [5])  # type: ignore[attr-defined]
        kernel.close()

    def test_the_voice_extension_carries_this_sdk(self):
        carried = HERE.parent.parent.parent / "marketplace" / "voice" / "zerolux.py"
        self.assertEqual(carried.read_text(), (HERE / "zerolux.py").read_text())


if __name__ == "__main__":
    unittest.main()
