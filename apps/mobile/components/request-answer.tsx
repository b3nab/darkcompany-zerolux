import { useState } from "react";
import { Linking, View } from "react-native";
import {
  fieldChoices,
  formAnswer,
  formOf,
  questionAnswer,
  questionsOf,
} from "@zerolux/chat";
import type {
  Approval,
  FormAnswer,
  FormField,
  QuestionAnswer,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

type Answer = (answer: QuestionAnswer | FormAnswer) => void;

function toggle(list: string[], value: string, multiple: boolean) {
  if (list.includes(value)) return list.filter((v) => v !== value);
  return multiple ? [...list, value] : [value];
}

/** One choice: picked or not. */
function Chip({
  label,
  description,
  on,
  onPress,
}: {
  label: string;
  description?: string | null;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={on ? "default" : "outline"}
      className="h-auto items-start justify-start px-3 py-2"
      onPress={onPress}
      accessibilityState={{ selected: on }}
    >
      <View className="gap-0.5">
        <Text>{label}</Text>
        {description ? (
          <Text className="text-xs font-normal opacity-80">{description}</Text>
        ) : null}
      </View>
    </Button>
  );
}

function Actions({
  busy,
  label,
  problem,
  submit,
  decline,
}: {
  busy: boolean;
  label: string;
  problem?: string;
  submit: () => void;
  decline: () => void;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <Button disabled={busy || problem !== undefined} onPress={submit}>
          <Text>{label}</Text>
        </Button>
        <Button variant="outline" disabled={busy} onPress={decline}>
          <Text>Decline</Text>
        </Button>
      </View>
      {problem ? <Text className="text-xs text-faint">{problem}</Text> : null}
    </View>
  );
}

/** Questions a session asks: choices, several choices, or free text. */
export function QuestionForm({
  approval,
  busy,
  answer,
}: {
  approval: Approval;
  busy: boolean;
  answer: Answer;
}) {
  const questions = questionsOf(approval);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.default ?? ""])),
  );
  const result = questionAnswer(questions, picks, texts);
  return (
    <View className="gap-4">
      {questions.map((q) => (
        <View key={q.id} className="gap-2">
          <Text className="text-sm font-semibold">
            {q.header ? `${q.header} · ` : ""}
            {q.question}
          </Text>
          {q.options.map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              description={option.description}
              on={(picks[q.id] ?? []).includes(option.label)}
              onPress={() =>
                setPicks((p) => ({
                  ...p,
                  [q.id]: toggle(p[q.id] ?? [], option.label, !!q.multiple),
                }))
              }
            />
          ))}
          {q.other || q.options.length === 0 ? (
            <Input
              accessibilityLabel={q.question}
              placeholder={
                q.placeholder ??
                (q.options.length ? "Or write your answer" : undefined)
              }
              secureTextEntry={q.secret === true}
              // A secret asked for by an agent, not a password iOS should offer to save.
              textContentType={q.secret === true ? "oneTimeCode" : undefined}
              multiline={q.multiline === true}
              className={q.multiline ? "h-28 py-2" : undefined}
              value={texts[q.id] ?? ""}
              onChangeText={(text) => setTexts((t) => ({ ...t, [q.id]: text }))}
            />
          ) : null}
        </View>
      ))}
      <Actions
        busy={busy}
        label="Answer"
        problem={typeof result === "string" ? result : undefined}
        submit={() => typeof result !== "string" && answer(result)}
        decline={() => answer({ declined: true })}
      />
    </View>
  );
}

function FieldInput({
  name,
  field,
  value,
  required,
  onChange,
}: {
  name: string;
  field: FormField;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${field.title ?? name}${required ? " *" : ""}`;
  const choices =
    field.type === "boolean"
      ? [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]
      : fieldChoices(field);
  const list =
    field.type === "array" && Array.isArray(value) ? (value as string[]) : [];
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">{label}</Text>
      {choices.length ? (
        choices.map((choice) => (
          <Chip
            key={choice.value}
            label={choice.label}
            on={
              field.type === "array"
                ? list.includes(choice.value)
                : field.type === "boolean"
                  ? value === (choice.value === "true")
                  : value === choice.value
            }
            onPress={() =>
              onChange(
                field.type === "array"
                  ? toggle(list, choice.value, true)
                  : field.type === "boolean"
                    ? choice.value === "true"
                    : choice.value,
              )
            }
          />
        ))
      ) : (
        <Input
          accessibilityLabel={label}
          keyboardType={field.type === "string" ? "default" : "numeric"}
          value={value === undefined ? "" : String(value)}
          onChangeText={onChange}
        />
      )}
      {field.description ? (
        <Text className="text-xs text-muted-foreground">
          {field.description}
        </Text>
      ) : null}
    </View>
  );
}

/** What an MCP server asks through the session: fields to fill in, or a link to open. */
export function McpForm({
  approval,
  busy,
  answer,
}: {
  approval: Approval;
  busy: boolean;
  answer: Answer;
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
  const result =
    form.mode === "url"
      ? { action: "accept" as const }
      : formAnswer(form, values);
  return (
    <View className="gap-4">
      <Text className="text-sm">
        <Text className="font-mono text-xs text-faint">{form.server} </Text>
        {form.message}
      </Text>
      {form.mode === "url" && form.url ? (
        <Button
          variant="link"
          className="h-auto self-start p-0"
          onPress={() => void Linking.openURL(form.url!)}
        >
          <Text className="underline">{form.url}</Text>
        </Button>
      ) : (
        Object.entries(fields).map(([name, field]) => (
          <FieldInput
            key={name}
            name={name}
            field={field}
            value={values[name]}
            required={form.schema?.required?.includes(name) === true}
            onChange={(value) => setValues((v) => ({ ...v, [name]: value }))}
          />
        ))
      )}
      <Actions
        busy={busy}
        label={form.mode === "url" ? "Done" : "Send"}
        problem={typeof result === "string" ? result : undefined}
        submit={() => typeof result !== "string" && answer(result)}
        decline={() => answer({ action: "decline" })}
      />
    </View>
  );
}
