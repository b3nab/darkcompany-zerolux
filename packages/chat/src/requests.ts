import { changeCount, patchCount, toolView } from "./tool-view";
import type {
  Approval,
  ApprovalScope,
  FormAnswer,
  FormField,
  FormRequest,
  Question,
  QuestionAnswer,
} from "./chat";

/** What each scope allows, as the owner chooses it. */
export const scopeLabels: Record<ApprovalScope, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow",
};
const allowed: Record<ApprovalScope, string> = {
  once: "Allowed once",
  session: "Allowed for this session",
  always: "Always allowed",
};

/** How far a permission can be allowed: as far as its harness offers, and once at least. */
export function scopesOf(approval: Approval): ApprovalScope[] {
  const offered = approval.details.scopes;
  const scopes = Array.isArray(offered)
    ? (Object.keys(scopeLabels) as ApprovalScope[]).filter((scope) =>
        offered.includes(scope),
      )
    : [];
  return scopes.length ? scopes : ["once"];
}

/** The questions of a `question` request. */
export const questionsOf = (approval: Approval) =>
  (approval.details.questions ?? []) as Question[];

/** The MCP request of a `form` request. */
export const formOf = (approval: Approval) =>
  approval.details as unknown as FormRequest;

/** A field's choices, with the titles to show; none for free input. */
export function fieldChoices(field: FormField) {
  const titled = field.oneOf ?? field.items?.anyOf;
  if (titled) return titled.map((o) => ({ value: o.const, label: o.title }));
  const values = field.enum ?? field.items?.enum ?? [];
  return values.map((value, i) => ({
    value,
    label: field.enumNames?.[i] ?? value,
  }));
}

/** The answer to the questions, or what is still missing. */
export function questionAnswer(
  questions: Question[],
  picks: Record<string, string[]>,
  texts: Record<string, string>,
): QuestionAnswer | string {
  const answers: Record<string, string[]> = {};
  for (const q of questions) {
    const text = texts[q.id]?.trim();
    const chosen = [...(picks[q.id] ?? []), ...(text ? [text] : [])];
    if (chosen.length === 0) return `Answer “${q.header || q.question}”`;
    if (!q.multiple && chosen.length > 1)
      return `Choose one answer for “${q.header || q.question}”`;
    answers[q.id] = chosen;
  }
  return { answers };
}

/** The form's content with typed values, or what is still missing or wrong. */
export function formAnswer(
  form: FormRequest,
  values: Record<string, unknown>,
): FormAnswer | string {
  const fields = form.schema?.properties ?? {};
  const content: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = values[name];
    const empty =
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (form.schema?.required?.includes(name))
        return `Fill in ${field.title ?? name}`;
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number)) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      )
        return `Check ${field.title ?? name}`;
      content[name] = number;
    } else content[name] = value;
  }
  return { action: "accept", content };
}

/** What the owner answered, in a line. */
export function answerSummary(approval: Approval): string {
  if (approval.kind === "permission")
    return approval.decision === "allow"
      ? allowed[approval.scope ?? "once"]
      : approval.decision === "deny"
        ? approval.reason
          ? `Denied: ${approval.reason}`
          : "Denied"
        : "";
  const answer = approval.answer;
  if (!answer) return "";
  if ("declined" in answer) return "Declined";
  if ("answers" in answer)
    return Object.values(answer.answers)
      .map((values) => values.join(", "))
      .join(" · ");
  if (answer.action !== "accept")
    return answer.action === "decline" ? "Declined" : "Cancelled";
  return formOf(approval).mode === "url" ? "Done" : "Sent";
}

/** A file a permission would change, with the lines it adds and removes where they are known. */
export interface ChangedFile {
  path: string;
  added?: number;
  removed?: number;
}

/**
 * What a permission asks, as a person reads it rather than as its harness sends it: what it
 * wants to do, and the command, files or address it would do it with.
 */
export interface PermissionShown {
  /** "wants to run", "wants to edit 3 files"… after the agent's name. */
  wants: string;
  command?: string;
  /** Where the command would run. */
  cwd?: string;
  files?: ChangedFile[];
  /** Anything else it says: an address, a search, a reason. */
  text?: string;
}

const said = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;
const fieldsOf = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
const editing = (count: number) =>
  count === 1 ? "wants to edit a file" : `wants to edit ${count} files`;

/** What a tool would do, from its name and input, as the Console draws it. */
function toolShown(name: string, input: unknown): PermissionShown {
  const view = toolView(name, input);
  switch (view.kind) {
    case "command":
      return {
        wants: "wants to run",
        command: view.script ?? view.commands.join("\n"),
        text: view.description,
      };
    case "edit":
      return {
        wants: "wants to edit a file",
        files: [{ path: view.path, ...changeCount(view.changes) }],
      };
    case "write":
      return {
        wants: "wants to write a file",
        files: [
          {
            path: view.path,
            ...changeCount([{ before: "", after: view.text }]),
          },
        ],
      };
    case "patch":
      return {
        wants: editing(view.files.length),
        files: view.files.map((path) => ({ path })),
      };
    case "read":
      return { wants: "wants to read", files: [{ path: view.path }] };
    case "search":
      return { wants: "wants to search for", text: view.pattern };
    case "web":
      return view.url
        ? { wants: "wants to open", text: view.url }
        : { wants: "wants to search the web for", text: view.query };
    case "mcp":
      return {
        wants: `wants to use ${view.server}: ${view.tool}`,
        text: JSON.stringify(view.args),
      };
    default:
      return {
        wants: `wants to use ${name}`,
        text: typeof input === "string" ? input : JSON.stringify(input),
      };
  }
}

/** A permission's request, read from what Claude Code, Codex or pi sent. */
export function permissionShown(approval: Approval): PermissionShown {
  const details = approval.details;
  // Claude Code: the tool and its input.
  if (typeof details.tool === "string")
    return toolShown(details.tool, details.input);
  // Codex: the item it would run or change, and its request.
  const item = fieldsOf(details.item);
  const params = fieldsOf(details.params);
  switch (details.method) {
    case "item/commandExecution/requestApproval": {
      const command = item.command ?? params.command;
      return {
        wants: "wants to run",
        command: Array.isArray(command) ? command.join(" ") : said(command),
        cwd: said(item.cwd) ?? said(params.cwd),
        text: said(params.reason),
      };
    }
    case "item/fileChange/requestApproval": {
      const files = (Array.isArray(item.changes) ? item.changes : [])
        .map(fieldsOf)
        .filter((change) => typeof change.path === "string")
        .map((change) => ({
          path: change.path as string,
          ...(typeof change.diff === "string" ? patchCount(change.diff) : {}),
        }));
      return {
        wants: files.length ? editing(files.length) : "wants to change files",
        files,
        text: said(params.reason),
      };
    }
    case "item/permissions/requestApproval":
      return { wants: "asks for more permissions", text: said(params.reason) };
    // pi: a confirmation, with its title and message.
    case "confirm":
      return {
        wants: "asks you to confirm",
        text:
          [said(details.title), said(details.message)]
            .filter(Boolean)
            .join(": ") || undefined,
      };
  }
  return { wants: "asks your permission", text: approval.summary };
}
