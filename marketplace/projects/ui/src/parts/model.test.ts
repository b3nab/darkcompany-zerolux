import { expect, test } from "bun:test";
import {
  byStatus,
  dueTone,
  keyFrom,
  labelsOf,
  matches,
  missing,
  sourceState,
} from "./model";
import type { Field, Source, Task } from "./model";

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  key: `AS-${id}`,
  source: "zl",
  project_id: "zl:aspen",
  title: id,
  description: "",
  status: "todo",
  priority: "none",
  assignee: null,
  labels: [],
  due: null,
  url: null,
  updated_at: 0,
  ...fields,
});

test("tasks group by state in the order work goes, the most pressing first", () => {
  const groups = byStatus([
    task("late", { due: "2026-03-02" }),
    task("soon", { due: "2026-03-01" }),
    task("urgent", { priority: "urgent" }),
    task("shipped", { status: "done" }),
  ]);
  expect(groups.map((g) => g.value)).toEqual([
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
  ]);
  expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["urgent", "soon", "late"]);
  expect(groups[4]!.tasks.map((t) => t.id)).toEqual(["shipped"]);
});

test("a due day turns red when due and amber in the week before, only while open", () => {
  const now = new Date(2026, 2, 10);
  expect(dueTone(task("a", { due: "2026-03-09" }), now)).toBe("danger");
  expect(dueTone(task("a", { due: "2026-03-10" }), now)).toBe("danger");
  expect(dueTone(task("a", { due: "2026-03-14" }), now)).toBe("warning");
  expect(dueTone(task("a", { due: "2026-03-30" }), now)).toBe("default");
  expect(dueTone(task("a", { due: "2026-03-09", status: "done" }), now)).toBe(
    "default",
  );
});

test("a new project's key comes from its name, and starts with a letter", () => {
  expect(keyFrom("Mobile app")).toBe("MA");
  expect(keyFrom("birch")).toBe("BIR");
  expect(keyFrom("2026 plan")).toBe("");
});

test("labels in use are listed once, in order", () => {
  expect(
    labelsOf([
      task("a", { labels: ["ui", "bug"] }),
      task("b", { labels: ["bug"] }),
    ]),
  ).toEqual(["bug", "ui"]);
});

test("a source says what keeps it from working, and a secret it has is not asked again", () => {
  const ready: Source = {
    id: "s",
    name: "Plane",
    tracker: "plane",
    config: {},
    available: true,
  };
  expect(sourceState(ready)).toBe("");
  expect(sourceState({ ...ready, error: "Plane refused (401)" })).toBe(
    "Plane refused (401)",
  );
  const fields: Field[] = [
    { key: "workspace", label: "Workspace", type: "text", required: true },
    { key: "api_key", label: "API key", type: "secret", required: true },
  ];
  expect(missing(fields, {}).map((f) => f.key)).toEqual([
    "workspace",
    "api_key",
  ]);
  expect(missing(fields, {}, { workspace: "acme" })).toEqual([]);
});

test("a search finds tasks by title, key or label, every word", () => {
  const found = task("birch", {
    title: "Write the landing copy",
    labels: ["web"],
  });
  expect(matches(found, "")).toBe(true);
  expect(matches(found, "landing")).toBe(true);
  expect(matches(found, "as-birch")).toBe(true);
  expect(matches(found, "WEB copy")).toBe(true);
  expect(matches(found, "copy pricing")).toBe(false);
});
