import { useId } from "react";
import { useActionForm } from "@zerolux/chat";
import type { ActionField, JsonSchema } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

type Form = ReturnType<typeof useActionForm>;

/** One field, drawn as its kind asks: its label, its control, what it is for and what is wrong. */
function Field({
  field,
  form,
  prefix,
}: {
  field: ActionField;
  form: Form;
  prefix: string;
}) {
  const id = `${prefix}-${field.key}`;
  const draft = form.drafts[field.key];
  const error = form.errors[field.key];
  const text = typeof draft === "string" ? draft : "";
  const label = (
    <>
      {field.label}
      {field.required ? (
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
      ) : (
        <span className="font-normal text-faint"> · optional</span>
      )}
    </>
  );
  const notes = (
    <>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
  const invalid = error
    ? { "aria-invalid": true, "aria-describedby": `${id}-error` }
    : {};
  if (field.kind === "group")
    return (
      <fieldset className="flex flex-col gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{label}</legend>
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
        <Fields fields={field.fields!} form={form} prefix={prefix} />
      </fieldset>
    );
  if (field.kind === "boolean")
    return (
      <div className="flex flex-col gap-1">
        <Label className="font-normal">
          <Checkbox
            checked={draft === true}
            onCheckedChange={(checked) => form.set(field.key, checked === true)}
            {...invalid}
          />
          {field.label}
        </Label>
        {notes}
      </div>
    );
  if (field.kind === "choices") {
    const chosen = Array.isArray(draft) ? draft : [];
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        {field.options!.map((option, index) => {
          const key = String(index);
          return (
            <Label key={key} className="font-normal">
              <Checkbox
                checked={chosen.includes(key)}
                onCheckedChange={(checked) =>
                  form.set(
                    field.key,
                    checked
                      ? [...chosen, key]
                      : chosen.filter((one) => one !== key),
                  )
                }
              />
              {option}
            </Label>
          );
        })}
        {notes}
      </fieldset>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {field.kind === "choice" ? (
        <NativeSelect
          id={id}
          className="w-full"
          value={text}
          onChange={(event) => form.set(field.key, event.target.value)}
          {...invalid}
        >
          <NativeSelectOption value="" disabled={field.required}>
            {field.required ? "Choose one" : "None"}
          </NativeSelectOption>
          {field.options!.map((option, index) => (
            <NativeSelectOption key={index} value={String(index)}>
              {option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : field.kind === "json" || field.kind === "list" || field.multiline ? (
        <Textarea
          id={id}
          value={text}
          rows={field.kind === "json" ? 5 : 3}
          placeholder={field.kind === "list" ? "One per line" : undefined}
          onChange={(event) => form.set(field.key, event.target.value)}
          className={
            field.kind === "json" ? "font-mono text-[12.5px]" : undefined
          }
          {...invalid}
        />
      ) : (
        <Input
          id={id}
          type={field.kind === "secret" ? "password" : "text"}
          autoComplete={field.kind === "secret" ? "off" : undefined}
          inputMode={
            field.kind === "integer"
              ? "numeric"
              : field.kind === "number"
                ? "decimal"
                : undefined
          }
          value={text}
          onChange={(event) => form.set(field.key, event.target.value)}
          {...invalid}
        />
      )}
      {notes}
    </div>
  );
}

function Fields({
  fields,
  form,
  prefix,
}: {
  fields: ActionField[];
  form: Form;
  prefix: string;
}) {
  return fields.map((field) => (
    <Field key={field.key} field={field} form={form} prefix={prefix} />
  ));
}

/**
 * An action's input, as a form drawn from its schema: each field as its kind asks, checked
 * before it runs, which the kernel checks again.
 */
export function ActionForm({
  schema,
  value,
  submit,
  busy,
  run,
}: {
  schema: JsonSchema | undefined;
  /** An earlier input, to start from. */
  value?: Record<string, unknown>;
  /** What the button says: the action's name. */
  submit: string;
  busy: boolean;
  run: (input: Record<string, unknown>) => void;
}) {
  const form = useActionForm(schema, value);
  const prefix = useId();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const input = form.submit();
        if (input) run(input);
      }}
    >
      <Fields fields={form.fields} form={form} prefix={prefix} />
      <Button type="submit" className="self-start" disabled={busy}>
        {submit}
      </Button>
    </form>
  );
}
