import { useState } from "react";
import {
  fieldChoices,
  formAnswer,
  formOf,
  questionAnswer,
  questionsOf,
} from "@zerolux/chat";
import type {
  Approval,
  Chat,
  FormField,
  Perform,
  Question,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

function toggle(list: string[], value: string, on: boolean) {
  return on ? [...list, value] : list.filter((v) => v !== value);
}

function Choice({
  id,
  label,
  description,
  multiple,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string | null;
  multiple: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {multiple ? (
        <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      ) : (
        <RadioGroupItem id={id} value={label} />
      )}
      <Label htmlFor={id} className="flex flex-col items-start gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description && (
          <span className="text-xs font-normal text-muted-foreground">
            {description}
          </span>
        )}
      </Label>
    </div>
  );
}

function QuestionInput({
  approval,
  question,
  picks,
  text,
  setPicks,
  setText,
}: {
  approval: string;
  question: Question;
  picks: string[];
  text: string;
  setPicks: (picks: string[]) => void;
  setText: (text: string) => void;
}) {
  const multiple = question.multiple === true;
  const free = question.other === true || question.options.length === 0;
  const choices = question.options.map((option, i) => (
    <Choice
      key={option.label}
      id={`${approval}-${question.id}-${i}`}
      label={option.label}
      description={option.description}
      multiple={multiple}
      checked={picks.includes(option.label)}
      onChange={(on) => setPicks(toggle(picks, option.label, on))}
    />
  ));
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1 text-sm font-semibold">
        {question.header && (
          <span className="mr-2 font-mono text-xs text-faint uppercase">
            {question.header}
          </span>
        )}
        {question.question}
      </legend>
      {question.options.length > 0 &&
        (multiple ? (
          choices
        ) : (
          <RadioGroup
            value={picks[0] ?? null}
            onValueChange={(value) => setPicks(value ? [String(value)] : [])}
          >
            {choices}
          </RadioGroup>
        ))}
      {free &&
        (question.multiline ? (
          <Textarea
            aria-label={question.question}
            placeholder={question.placeholder ?? undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <Input
            aria-label={question.question}
            type={question.secret ? "password" : "text"}
            placeholder={
              question.placeholder ??
              (question.options.length ? "Other" : undefined)
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ))}
    </fieldset>
  );
}

/** Questions a session asks: choices, several choices, or free text. */
export function QuestionForm({
  approval,
  chat,
  busy,
  perform,
}: {
  approval: Approval;
  chat: Chat;
  busy: boolean;
  perform: Perform;
}) {
  const questions = questionsOf(approval);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.default ?? ""])),
  );
  const answer = questionAnswer(questions, picks, texts);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (typeof answer !== "string")
          void perform(() => chat.answer(approval.id, answer));
      }}
    >
      {questions.map((question) => (
        <QuestionInput
          key={question.id}
          approval={approval.id}
          question={question}
          picks={picks[question.id] ?? []}
          text={texts[question.id] ?? ""}
          setPicks={(list) => setPicks((p) => ({ ...p, [question.id]: list }))}
          setText={(text) => setTexts((t) => ({ ...t, [question.id]: text }))}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || typeof answer === "string"}>
          Answer
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(() => chat.answer(approval.id, { declined: true }))
          }
        >
          Decline
        </Button>
        {typeof answer === "string" && (
          <span className="text-xs text-faint">{answer}</span>
        )}
      </div>
    </form>
  );
}

function FieldInput({
  id,
  name,
  field,
  value,
  required,
  onChange,
}: {
  id: string;
  name: string;
  field: FormField;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${field.title ?? name}${required ? " *" : ""}`;
  const choices = fieldChoices(field);
  if (field.type === "boolean")
    return (
      <div className="flex items-center gap-2.5">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(on) => onChange(on)}
        />
        <Label htmlFor={id}>{label}</Label>
      </div>
    );
  if (field.type === "array") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        {choices.map((choice, i) => (
          <div key={choice.value} className="flex items-center gap-2.5">
            <Checkbox
              id={`${id}-${i}`}
              checked={list.includes(choice.value)}
              onCheckedChange={(on) => onChange(toggle(list, choice.value, on))}
            />
            <Label htmlFor={`${id}-${i}`}>{choice.label}</Label>
          </div>
        ))}
      </fieldset>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {choices.length ? (
        <NativeSelect
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <NativeSelectOption value="">Choose…</NativeSelectOption>
          {choices.map((choice) => (
            <NativeSelectOption key={choice.value} value={choice.value}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <Input
          id={id}
          type={field.type === "string" ? "text" : "number"}
          min={field.minimum}
          max={field.maximum}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.description && (
        <span className="text-xs text-muted-foreground">
          {field.description}
        </span>
      )}
    </div>
  );
}

/** What an MCP server asks through the session: fields to fill in, or a link to open. */
export function McpForm({
  approval,
  chat,
  busy,
  perform,
}: {
  approval: Approval;
  chat: Chat;
  busy: boolean;
  perform: Perform;
}) {
  const form = formOf(approval);
  const fields = form.schema?.properties ?? {};
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      Object.entries(fields)
        .filter(([, field]) => field.default !== undefined)
        .map(([name, field]) => [name, field.default]),
    ),
  );
  const answer =
    form.mode === "url"
      ? { action: "accept" as const }
      : formAnswer(form, values);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (typeof answer !== "string")
          void perform(() => chat.answer(approval.id, answer));
      }}
    >
      <p className="text-sm">
        <span className="font-mono text-xs text-faint">{form.server}</span>{" "}
        {form.message}
      </p>
      {form.mode === "url" ? (
        <a
          href={form.url}
          target="_blank"
          rel="noreferrer noopener"
          className="self-start text-sm break-all underline"
        >
          {form.url}
        </a>
      ) : (
        Object.entries(fields).map(([name, field]) => (
          <FieldInput
            key={name}
            id={`${approval.id}-${name}`}
            name={name}
            field={field}
            value={values[name]}
            required={form.schema?.required?.includes(name) === true}
            onChange={(value) => setValues((v) => ({ ...v, [name]: value }))}
          />
        ))
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || typeof answer === "string"}>
          {form.mode === "url" ? "Done" : "Send"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(() => chat.answer(approval.id, { action: "decline" }))
          }
        >
          Decline
        </Button>
        {typeof answer === "string" && (
          <span className="text-xs text-faint">{answer}</span>
        )}
      </div>
    </form>
  );
}
