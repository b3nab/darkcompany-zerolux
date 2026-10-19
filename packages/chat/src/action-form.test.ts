import { expect, test } from "bun:test";
import { actionDrafts, actionFields, actionInput } from "./action-form";
import type { JsonSchema } from "./action-form";

const schema: JsonSchema = {
  type: "object",
  required: ["title", "priority"],
  properties: {
    title: { type: "string", description: "What the task is", maxLength: 80 },
    notes: { type: "string", format: "textarea" },
    priority: { enum: ["low", "high", 3] },
    estimate: { type: "integer", minimum: 1, maximum: 10 },
    ratio: { type: ["number", "null"] },
    done: { type: "boolean", default: true },
    labels: {
      type: "array",
      items: { enum: ["bug", "chore"] },
      maxItems: 1,
    },
    points: { type: "array", items: { type: "number" } },
    api_key: { type: "string", format: "password", title: "Key" },
    assignee: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, dueDate: { type: "string" } },
    },
    extra: { type: "array", items: { type: "object" } },
  },
};

test("an action's input becomes the fields a client draws", () => {
  const fields = actionFields(schema);
  expect(fields.map((f) => [f.key, f.kind, f.label, f.required])).toEqual([
    ["title", "text", "Title", true],
    ["notes", "text", "Notes", false],
    ["priority", "choice", "Priority", true],
    ["estimate", "integer", "Estimate", false],
    ["ratio", "number", "Ratio", false],
    ["done", "boolean", "Done", false],
    ["labels", "choices", "Labels", false],
    ["points", "list", "Points", false],
    ["api_key", "secret", "Key", false],
    ["assignee", "group", "Assignee", false],
    ["extra", "json", "Extra", false],
  ]);
  expect(fields[0]!.description).toBe("What the task is");
  expect(fields[1]!.multiline).toBe(true);
  expect(fields[2]!.options).toEqual(["low", "high", "3"]);
  const assignee = fields.find((f) => f.key === "assignee")!;
  expect(assignee.fields!.map((f) => [f.key, f.label, f.required])).toEqual([
    ["assignee.name", "Name", true],
    ["assignee.dueDate", "Due date", false],
  ]);
  expect(actionFields(undefined)).toEqual([]);
});

test("drafts start from an earlier input, else from the schema's defaults", () => {
  const fields = actionFields(schema);
  expect(actionDrafts(fields)).toMatchObject({
    title: "",
    priority: "",
    done: true,
    labels: [],
    points: "",
    "assignee.name": "",
    extra: "",
  });
  expect(
    actionDrafts(fields, {
      title: "Ship it",
      priority: 3,
      estimate: 2,
      labels: ["chore"],
      points: [1.5, 2],
      assignee: { name: "aspen" },
      extra: [{ a: 1 }],
    }),
  ).toMatchObject({
    title: "Ship it",
    priority: "2",
    estimate: "2",
    labels: ["1"],
    points: "1.5\n2",
    "assignee.name": "aspen",
    extra: '[\n  {\n    "a": 1\n  }\n]',
  });
});

test("the drafts make the input, as the schema has it, with what is wrong in each field", () => {
  const fields = actionFields(schema);
  const empty = actionInput(fields, actionDrafts(fields));
  expect(empty.errors).toEqual({ title: "Required", priority: "Required" });
  // An empty group that is not required is left out; a switch always says.
  expect(empty.input).toEqual({ done: true });

  const drafts = {
    ...actionDrafts(fields),
    title: "Ship it",
    priority: "2",
    estimate: " 4 ",
    ratio: "0.5",
    labels: ["0"],
    points: "1\n\n2.5\n",
    api_key: "sk-test",
    "assignee.name": "birch",
    extra: '[{"a": 1}]',
  };
  expect(actionInput(fields, drafts)).toEqual({
    input: {
      title: "Ship it",
      priority: 3,
      estimate: 4,
      ratio: 0.5,
      done: true,
      labels: ["bug"],
      points: [1, 2.5],
      api_key: "sk-test",
      assignee: { name: "birch" },
      extra: [{ a: 1 }],
    },
    errors: {},
  });

  const wrong = actionInput(fields, {
    ...drafts,
    title: "x".repeat(81),
    estimate: "2.5",
    ratio: "half",
    labels: ["0", "1"],
    points: "1\ntwo",
    // Once a group is filled in, its required fields are asked for.
    "assignee.name": "",
    "assignee.dueDate": "2026-10-20",
    extra: "{",
  });
  expect(wrong.errors).toEqual({
    title: "At most 80 characters",
    estimate: "A whole number",
    ratio: "Not a number",
    labels: "Choose at most 1",
    points: "Line 2: Not a number",
    "assignee.name": "Required",
    extra: "Not valid JSON",
  });
  expect(
    actionInput(fields, { ...drafts, estimate: "11" }).errors.estimate,
  ).toBe("At most 10");
});

test("a pattern the client cannot read is left to the kernel", () => {
  const fields = actionFields({
    type: "object",
    properties: {
      code: { type: "string", pattern: "^[a-z]+$" },
      odd: { type: "string", pattern: "(?<" },
    },
  });
  expect(actionInput(fields, { code: "Abc", odd: "anything" }).errors).toEqual({
    code: "Not in the expected form",
  });
});

test("values with labels, as oneOf of consts, are a choice by their titles", () => {
  const fields = actionFields({
    type: "object",
    required: ["model"],
    properties: {
      model: {
        oneOf: [
          { const: "turbo", title: "Whisper large-v3 turbo" },
          { const: "parakeet", title: "Parakeet v3" },
          { const: 3 },
        ],
      },
      tags: {
        type: "array",
        items: {
          oneOf: [
            { const: "a", title: "First" },
            { const: "b", title: "Second" },
          ],
        },
      },
    },
  });
  expect(fields.map((f) => [f.key, f.kind, f.options])).toEqual([
    ["model", "choice", ["Whisper large-v3 turbo", "Parakeet v3", "3"]],
    ["tags", "choices", ["First", "Second"]],
  ]);
  const drafts = actionDrafts(fields, { model: "parakeet", tags: ["b"] });
  expect(drafts).toEqual({ model: "1", tags: ["1"] });
  expect(actionInput(fields, { model: "2", tags: ["0", "1"] }).input).toEqual({
    model: 3,
    tags: ["a", "b"],
  });
});
