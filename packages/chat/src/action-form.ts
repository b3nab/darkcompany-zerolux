import { useMemo, useState } from "react";

/**
 * The form of an action, from the JSON Schema of its input: the fields a client draws with its
 * own components, the drafts they start from, and the input the drafts make, with what is
 * wrong in each field. The kernel checks the input again when the action runs.
 */

/** The part of JSON Schema an action's input is drawn from; anything else is edited as JSON. */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  /** With `const` in each: values with their labels (`title`), drawn as a choice. */
  oneOf?: JsonSchema[];
  const?: unknown;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
}

/**
 * How a field is edited:
 * - `text`, `number`, `integer`, `json`: typed, the draft is the text;
 * - `secret`: typed and hidden (`format: "password"`);
 * - `boolean`: a switch;
 * - `choice`: one of `options`; `choices`: several of them;
 * - `list`: one item per line;
 * - `group`: an object, its own `fields`.
 */
export type ActionFieldKind =
  | "text"
  | "secret"
  | "number"
  | "integer"
  | "boolean"
  | "choice"
  | "choices"
  | "list"
  | "group"
  | "json";

export interface ActionField {
  /** Where its draft is kept and its error is said: the property names, joined by dots. */
  key: string;
  path: string[];
  label: string;
  description?: string;
  required: boolean;
  kind: ActionFieldKind;
  /** A longer text, drawn on several lines. */
  multiline?: boolean;
  /** For `choice` and `choices`: each option's label, its key being its index. */
  options?: string[];
  /** For `group`. */
  fields?: ActionField[];
  schema: JsonSchema;
}

/** What each field holds while it is edited: text, a switch, or the keys of chosen options. */
export type ActionDraft = string | boolean | string[];
export type ActionDrafts = Record<string, ActionDraft>;

const typeOf = (schema: JsonSchema) =>
  (Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type) ??
  (schema.properties ? "object" : choiceValues(schema) ? "string" : undefined);

/** A choice's values: an `enum`, or a `oneOf` whose every entry is a `const`. */
function choiceValues(schema: JsonSchema): unknown[] | undefined {
  if (schema.enum) return schema.enum;
  if (schema.oneOf?.length && schema.oneOf.every((o) => "const" in o))
    return schema.oneOf.map((o) => o.const);
}

/** A choice's labels, in the order of its values: a `oneOf` entry's title, else the value. */
const choiceLabels = (schema: JsonSchema) =>
  schema.enum
    ? schema.enum.map(optionLabel)
    : schema.oneOf!.map((o) => o.title ?? optionLabel(o.const));

/** `linear_token` and `dueDate` read as "Linear token" and "Due date". */
const labelOf = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const optionLabel = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

const scalar = (type: string | undefined) =>
  type === "string" || type === "number" || type === "integer";

function field(
  key: string,
  schema: JsonSchema,
  path: string[],
  required: boolean,
): ActionField {
  const type = typeOf(schema);
  const base = {
    key: path.join("."),
    path,
    label: schema.title ?? labelOf(key),
    description: schema.description,
    required,
    schema,
  };
  if (choiceValues(schema)) {
    return { ...base, kind: "choice", options: choiceLabels(schema) };
  }
  if (type === "boolean") return { ...base, kind: "boolean" };
  if (type === "number" || type === "integer") return { ...base, kind: type };
  if (type === "string") {
    return {
      ...base,
      kind: schema.format === "password" ? "secret" : "text",
      multiline: schema.format === "textarea" || (schema.maxLength ?? 0) > 200,
    };
  }
  if (type === "array" && schema.items) {
    const items = schema.items;
    if (choiceValues(items))
      return { ...base, kind: "choices", options: choiceLabels(items) };
    if (scalar(typeOf(items))) return { ...base, kind: "list" };
  }
  if (type === "object" && schema.properties) {
    return { ...base, kind: "group", fields: actionFields(schema, path) };
  }
  return { ...base, kind: "json" };
}

/** The fields of an action's input, in the order its schema lists them. */
export function actionFields(
  schema: JsonSchema | undefined,
  path: string[] = [],
): ActionField[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([key, property]) =>
    field(key, property, [...path, key], required.has(key)),
  );
}

const indexOf = (options: unknown[], value: unknown) =>
  options.findIndex(
    (option) => JSON.stringify(option) === JSON.stringify(value),
  );

/** Each field's draft, from a value given (an earlier input) or else its schema's `default`. */
export function actionDrafts(
  fields: ActionField[],
  value: Record<string, unknown> = {},
): ActionDrafts {
  const drafts: ActionDrafts = {};
  for (const f of fields) {
    const given = value[f.path.at(-1)!] ?? f.schema.default;
    switch (f.kind) {
      case "group":
        Object.assign(
          drafts,
          actionDrafts(
            f.fields!,
            given && typeof given === "object"
              ? (given as Record<string, unknown>)
              : {},
          ),
        );
        break;
      case "boolean":
        drafts[f.key] = given === true;
        break;
      case "choice": {
        const index =
          given === undefined ? -1 : indexOf(choiceValues(f.schema)!, given);
        drafts[f.key] = index < 0 ? "" : String(index);
        break;
      }
      case "choices":
        drafts[f.key] = Array.isArray(given)
          ? given
              .map((item) => indexOf(choiceValues(f.schema.items!)!, item))
              .filter((index) => index >= 0)
              .map(String)
          : [];
        break;
      case "list":
        drafts[f.key] = Array.isArray(given)
          ? given.map(String).join("\n")
          : "";
        break;
      case "json":
        drafts[f.key] =
          given === undefined ? "" : JSON.stringify(given, null, 2);
        break;
      default:
        drafts[f.key] = given === undefined ? "" : String(given);
    }
  }
  return drafts;
}

/** A typed number, or why it is not one. */
function numberOf(text: string, schema: JsonSchema, integer: boolean) {
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: "Not a number" };
  if (integer && !Number.isInteger(n)) return { error: "A whole number" };
  if (schema.minimum !== undefined && n < schema.minimum)
    return { error: `At least ${schema.minimum}` };
  if (schema.maximum !== undefined && n > schema.maximum)
    return { error: `At most ${schema.maximum}` };
  return { value: n };
}

/** A pattern the client cannot read is left to the kernel's own check. */
function matches(pattern: string, text: string) {
  try {
    return new RegExp(pattern, "u").test(text);
  } catch {
    return true;
  }
}

function textOf(text: string, schema: JsonSchema) {
  if (schema.minLength !== undefined && text.length < schema.minLength)
    return { error: `At least ${schema.minLength} characters` };
  if (schema.maxLength !== undefined && text.length > schema.maxLength)
    return { error: `At most ${schema.maxLength} characters` };
  if (schema.pattern !== undefined && !matches(schema.pattern, text))
    return { error: "Not in the expected form" };
  return { value: text };
}

/** One item of a list, as its items' type says. */
function itemOf(text: string, schema: JsonSchema) {
  const type = typeOf(schema);
  return type === "number" || type === "integer"
    ? numberOf(text, schema, type === "integer")
    : textOf(text, schema);
}

/** Whether anything was put in a field: a switch turned on counts, one left off does not. */
function filled(f: ActionField, drafts: ActionDrafts): boolean {
  const draft = drafts[f.key];
  if (f.kind === "group")
    return f.fields!.some((inner) => filled(inner, drafts));
  if (f.kind === "boolean") return draft === true;
  if (Array.isArray(draft)) return draft.length > 0;
  return typeof draft === "string" && draft.trim() !== "";
}

/**
 * The input the drafts make, as the action's schema has it, and what is wrong in each field,
 * by its key. Fields left empty and not required are left out.
 */
export function actionInput(
  fields: ActionField[],
  drafts: ActionDrafts,
): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const name = f.path.at(-1)!;
    const draft = drafts[f.key];
    const missing = () => {
      if (f.required) errors[f.key] = "Required";
    };
    switch (f.kind) {
      case "group": {
        // An optional group nobody filled in is left out, with its own required fields.
        if (!f.required && !filled(f, drafts)) break;
        const inner = actionInput(f.fields!, drafts);
        Object.assign(errors, inner.errors);
        input[name] = inner.input;
        break;
      }
      case "boolean":
        input[name] = draft === true;
        break;
      case "choice":
        if (typeof draft === "string" && draft !== "")
          input[name] = choiceValues(f.schema)![Number(draft)];
        else missing();
        break;
      case "choices": {
        const chosen = Array.isArray(draft) ? draft : [];
        if (chosen.length) {
          input[name] = chosen.map(
            (key) => choiceValues(f.schema.items!)![Number(key)],
          );
          if (
            f.schema.minItems !== undefined &&
            chosen.length < f.schema.minItems
          )
            errors[f.key] = `Choose at least ${f.schema.minItems}`;
          if (
            f.schema.maxItems !== undefined &&
            chosen.length > f.schema.maxItems
          )
            errors[f.key] = `Choose at most ${f.schema.maxItems}`;
        } else missing();
        break;
      }
      case "list": {
        const lines = String(draft ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        if (!lines.length) {
          missing();
          break;
        }
        const items = lines.map((line) => itemOf(line, f.schema.items!));
        const wrong = items.findIndex((item) => "error" in item);
        if (wrong >= 0)
          errors[f.key] = `Line ${wrong + 1}: ${items[wrong]!.error}`;
        else input[name] = items.map((item) => item.value);
        break;
      }
      case "json": {
        const text = String(draft ?? "").trim();
        if (!text) {
          missing();
          break;
        }
        try {
          input[name] = JSON.parse(text);
        } catch {
          errors[f.key] = "Not valid JSON";
        }
        break;
      }
      default: {
        const text = String(draft ?? "");
        if (!text.trim()) {
          missing();
          break;
        }
        const read =
          f.kind === "number" || f.kind === "integer"
            ? numberOf(text.trim(), f.schema, f.kind === "integer")
            : textOf(text, f.schema);
        if ("error" in read) errors[f.key] = read.error!;
        else input[name] = read.value;
      }
    }
  }
  return { input, errors };
}

/**
 * A form for an action's input, as a client draws it: its fields and their drafts, what is
 * wrong in each once it was sent, and `submit`, which gives the input when nothing is.
 */
export function useActionForm(
  schema: JsonSchema | undefined,
  value?: Record<string, unknown>,
) {
  const fields = useMemo(() => actionFields(schema), [schema]);
  const [drafts, setDrafts] = useState(() => actionDrafts(fields, value));
  const [errors, setErrors] = useState<Record<string, string>>({});
  return {
    fields,
    drafts,
    errors,
    /** A field edited: its error goes until the next submit. */
    set(key: string, draft: ActionDraft) {
      setDrafts((was) => ({ ...was, [key]: draft }));
      setErrors((was) => {
        if (!(key in was)) return was;
        const { [key]: _, ...rest } = was;
        return rest;
      });
    },
    submit() {
      const read = actionInput(fields, drafts);
      setErrors(read.errors);
      return Object.keys(read.errors).length ? undefined : read.input;
    },
  };
}
