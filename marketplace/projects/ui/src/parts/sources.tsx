import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Select,
  Sheet,
  Stack,
  Switch,
  Text,
  useAction,
  useActionResult,
  useOpen,
} from "@zerolux/ui";
import { filled, missing } from "./model";
import type { Field, Source, Tracker } from "./model";

/** What a sheet about sources asks. */
export type SourceAsk =
  | { kind: "add" }
  | { kind: "change"; source: Source }
  | { kind: "remove"; source: Source };

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A tracker's fields, as inputs. */
function Fields({
  fields,
  values,
  set,
  changing,
}: {
  fields: Field[];
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  changing?: boolean;
}) {
  return (
    <>
      {fields.map((field) =>
        field.type === "choice" ? (
          <Select
            key={field.key}
            label={field.label}
            value={String(values[field.key] ?? "")}
            options={field.options ?? []}
            onChange={(value) => set(field.key, value)}
          />
        ) : field.type === "boolean" ? (
          <Switch
            key={field.key}
            label={field.label}
            value={values[field.key] === true}
            onChange={(value) => set(field.key, value)}
          />
        ) : (
          <Stack key={field.key} gap={4}>
            <Input
              label={field.label}
              value={String(values[field.key] ?? "")}
              secure={field.type === "secret"}
              placeholder={
                field.type === "secret" && changing ? "Unchanged" : undefined
              }
              onChange={(value) => set(field.key, value)}
            />
            {field.description && (
              <Text tone="muted" size="sm">
                {field.description}
              </Text>
            )}
          </Stack>
        ),
      )}
    </>
  );
}

/** Adding a tracker's workspace as a source, changing one, or removing it. */
export function SourceSheet({
  ask,
  close,
  done,
}: {
  ask: SourceAsk | undefined;
  close: () => void;
  done: () => void;
}) {
  const add = useAction("add_source");
  const change = useAction("change_source");
  const signIn = useAction("sign_in");
  const remove = useAction("remove_source");
  const open = useOpen();
  const trackers = useActionResult<{ trackers: Tracker[] }>("trackers", {});
  const [name, setName] = useState("");
  const [tracker, setTracker] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [failed, setFailed] = useState("");
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    setFailed("");
    setWaiting(false);
    setTracker("");
    setName(ask && ask.kind !== "add" ? ask.source.name : "");
    setValues(ask?.kind === "change" ? { ...ask.source.config } : {});
  }, [ask]);
  if (!ask) return null;

  const known = trackers.data?.trackers ?? [];
  const chosen = known.find((t) =>
    ask.kind === "add"
      ? t.tracker === tracker
      : t.tracker === ask.source.tracker,
  );
  const fields =
    ask.kind === "change" && ask.source.own ? [] : (chosen?.fields ?? []);
  const set = (key: string, value: unknown) =>
    setValues((was) => ({ ...was, [key]: value }));
  /** After a source is added or changed: its tracker's sign-in, if it asks for one. */
  const signedIn = async (result: unknown) => {
    const url = (result as { sign_in?: { url?: string } | null })?.sign_in?.url;
    if (!url) return true;
    await open(url);
    setWaiting(true);
    return false;
  };
  const step =
    ask.kind === "add"
      ? {
          title: "Add source",
          submit: chosen?.sign_in ? "Sign in" : "Add",
          busy: add.busy,
          blocked:
            !name.trim() || !chosen || missing(fields, values).length > 0,
          go: async () =>
            signedIn(
              await add.run({
                name: name.trim(),
                tracker: chosen!.tracker,
                config: filled(fields, values),
              }),
            ),
        }
      : ask.kind === "change"
        ? {
            title: ask.source.name,
            submit: "Save",
            busy: change.busy,
            blocked:
              !name.trim() ||
              missing(fields, values, ask.source.config).length > 0,
            go: async () =>
              signedIn(
                await change.run({
                  id: ask.source.id,
                  name: name.trim(),
                  ...(fields.length ? { config: filled(fields, values) } : {}),
                }),
              ),
          }
        : {
            title: `Remove ${ask.source.name}?`,
            submit: "Remove",
            danger: true,
            busy: remove.busy,
            blocked: false,
            go: async () => {
              await remove.run({ id: ask.source.id });
              return true;
            },
          };
  const submit = () => {
    if (step.blocked || step.busy) return;
    setFailed("");
    step.go().then(
      (finished) => {
        if (!finished) return;
        close();
        done();
      },
      (error: unknown) => setFailed(message(error)),
    );
  };

  return (
    <Sheet open onClose={close} title={step.title}>
      <Stack gap={12}>
        {waiting ? (
          <>
            <Text tone="muted">Waiting for the sign-in</Text>
            <Button
              title="Done"
              variant="primary"
              onPress={() => (close(), done())}
            />
          </>
        ) : (
          <>
            {ask.kind !== "remove" && (
              <Input
                label="Name"
                value={name}
                onChange={setName}
                autoFocus
                onSubmit={submit}
              />
            )}
            {ask.kind === "add" && (
              <Select
                label="Tracker"
                value={tracker}
                placeholder={trackers.loading ? "Loading" : "Choose"}
                options={known
                  .filter((t) => !t.error)
                  .map((t) => ({ value: t.tracker, label: t.title }))}
                onChange={(value) => {
                  setTracker(value);
                  setValues({});
                }}
              />
            )}
            {ask.kind === "add" && chosen?.description && (
              <Text tone="muted" size="sm">
                {chosen.description}
              </Text>
            )}
            {ask.kind !== "remove" && (
              <Fields
                fields={fields}
                values={values}
                set={set}
                changing={ask.kind === "change"}
              />
            )}
            {ask.kind === "change" && ask.source.account && (
              <Text tone="muted" size="sm">
                {ask.source.account}
              </Text>
            )}
            {failed && <Text tone="danger">{failed}</Text>}
            <Stack direction="row" gap={8}>
              <Button
                title={step.submit}
                variant={"danger" in step && step.danger ? "danger" : "primary"}
                busy={step.busy}
                disabled={step.blocked}
                onPress={submit}
              />
              {ask.kind === "change" && chosen?.sign_in && (
                <Button
                  title="Sign in again"
                  busy={signIn.busy}
                  onPress={() =>
                    void signIn
                      .run({ id: ask.source.id })
                      .then(signedIn, (error: unknown) =>
                        setFailed(message(error)),
                      )
                  }
                />
              )}
              <Button title="Cancel" variant="ghost" onPress={close} />
            </Stack>
          </>
        )}
      </Stack>
    </Sheet>
  );
}
