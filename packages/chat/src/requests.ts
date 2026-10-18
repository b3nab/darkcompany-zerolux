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
