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
import {
  filled,
  missing,
  parent,
  within,
  type Entry,
  type Field,
  type Location,
  type Provider,
} from "./files";

/** What a sheet asks before something changes, and what it is about. */
export type Ask =
  | { kind: "new-folder"; location: string; folder: string }
  | { kind: "rename" | "delete"; location: string; entry: Entry }
  | { kind: "move" | "copy"; location: string; entry: Entry }
  | { kind: "add-location" }
  | { kind: "location"; location: Location }
  | { kind: "remove-location"; location: Location };

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A provider's fields, as inputs. */
function Fields({
  fields,
  values,
  set,
  changing,
}: {
  fields: Field[];
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  /** Changing a location: its secrets are kept unless given again. */
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

/**
 * The sheet for one question: a name, where to move or copy to, a location to add or change,
 * or a yes to delete. `done` follows each change.
 */
export function Asking({
  ask,
  locations,
  close,
  done,
}: {
  ask: Ask | undefined;
  locations: Location[];
  close: () => void;
  done: () => void;
}) {
  const create = useAction("create_folder");
  const rename = useAction("rename");
  const move = useAction("move");
  const copy = useAction("copy");
  const remove = useAction("delete");
  const add = useAction("add_location");
  const change = useAction("change_location");
  const signIn = useAction("sign_in");
  const removeLocation = useAction("remove_location");
  const open = useOpen();
  const adding = ask?.kind === "add-location";
  const providers = useActionResult<{ providers: Provider[] }>("providers", {});
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [provider, setProvider] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [failed, setFailed] = useState("");
  const [waiting, setWaiting] = useState(false);
  // Each question starts from what it is about.
  useEffect(() => {
    setFailed("");
    setWaiting(false);
    setValues(ask?.kind === "location" ? { ...ask.location.config } : {});
    setProvider("");
    setText(
      ask?.kind === "rename"
        ? ask.entry.name
        : ask?.kind === "location"
          ? ask.location.name
          : ask?.kind === "move" || ask?.kind === "copy"
            ? parent(ask.entry.path)
            : "",
    );
    setTarget(
      ask && "location" in ask && typeof ask.location === "string"
        ? ask.location
        : "",
    );
  }, [ask]);
  if (!ask) return null;

  const known = providers.data?.providers ?? [];
  const chosen = known.find((p) =>
    ask.kind === "location"
      ? p.provider === ask.location.provider
      : p.provider === provider,
  );
  const fields = chosen?.fields ?? [];
  const name = text.trim();
  const set = (key: string, value: unknown) =>
    setValues((was) => ({ ...was, [key]: value }));
  /** After a location is added or changed: its service's sign-in, if it asks for one. */
  const signedIn = async (result: unknown) => {
    const url = (result as { sign_in?: { url?: string } | null })?.sign_in?.url;
    if (!url) return true;
    await open(url);
    setWaiting(true);
    return false;
  };

  const step = (() => {
    switch (ask.kind) {
      case "new-folder":
        return {
          title: "New folder",
          submit: "Create",
          busy: create.busy,
          blocked: !name,
          go: () =>
            create.run({
              location: ask.location,
              path: within(ask.folder, name),
            }),
        };
      case "rename":
        return {
          title: "Rename",
          submit: "Rename",
          busy: rename.busy,
          blocked: !name,
          go: () =>
            rename.run({ location: ask.location, path: ask.entry.path, name }),
        };
      case "move":
      case "copy": {
        const action = ask.kind === "move" ? move : copy;
        return {
          title: `${ask.kind === "move" ? "Move" : "Copy"} ${ask.entry.name}`,
          submit: ask.kind === "move" ? "Move" : "Copy",
          busy: action.busy,
          blocked: !target,
          go: () =>
            action.run({
              location: ask.location,
              path: ask.entry.path,
              to_location: target,
              to: text.trim(),
            }),
        };
      }
      case "delete":
        return {
          title: `Delete ${ask.entry.name}${ask.entry.kind === "folder" ? " and everything in it" : ""}?`,
          submit: "Delete",
          danger: true,
          busy: remove.busy,
          go: () =>
            remove.run({ location: ask.location, path: ask.entry.path }),
        };
      case "add-location":
        return {
          title: "Add location",
          submit: chosen?.sign_in ? "Sign in" : "Add",
          busy: add.busy,
          blocked: !name || !chosen || missing(fields, values).length > 0,
          go: async () =>
            signedIn(
              await add.run({
                name,
                provider: chosen!.provider,
                config: filled(fields, values),
              }),
            ),
        };
      case "location":
        return {
          title: ask.location.name,
          submit: "Save",
          busy: change.busy,
          blocked:
            !name || missing(fields, values, ask.location.config).length > 0,
          go: async () =>
            signedIn(
              await change.run({
                id: ask.location.id,
                name,
                ...(fields.length ? { config: filled(fields, values) } : {}),
              }),
            ),
        };
      case "remove-location":
        return {
          title: `Remove ${ask.location.name}?`,
          submit: "Remove",
          danger: true,
          busy: removeLocation.busy,
          go: () => removeLocation.run({ id: ask.location.id }),
        };
    }
  })();
  const submit = () => {
    if (step.blocked || step.busy) return;
    setFailed("");
    Promise.resolve(step.go()).then(
      (finished) => {
        if (finished === false) return;
        close();
        done();
      },
      (error: unknown) => setFailed(message(error)),
    );
  };
  const places = locations
    .filter((location) => location.capabilities.includes("write"))
    .map((location) => ({ value: location.id, label: location.name }));

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
            {(ask.kind === "new-folder" ||
              ask.kind === "rename" ||
              ask.kind === "add-location" ||
              ask.kind === "location") && (
              <Input
                label={
                  ask.kind === "add-location" || ask.kind === "location"
                    ? "Name"
                    : undefined
                }
                value={text}
                onChange={setText}
                placeholder="Name"
                autoFocus
                onSubmit={submit}
              />
            )}
            {(ask.kind === "move" || ask.kind === "copy") && (
              <>
                <Select
                  label="Location"
                  value={target}
                  options={places}
                  onChange={setTarget}
                />
                <Input
                  label="Folder"
                  value={text}
                  onChange={setText}
                  placeholder="The top of the location"
                  onSubmit={submit}
                />
              </>
            )}
            {adding && (
              <Select
                label="Provider"
                value={provider}
                placeholder={providers.loading ? "Loading" : "Choose"}
                options={known
                  .filter((p) => !p.error)
                  .map((p) => ({ value: p.provider, label: p.title }))}
                onChange={(value) => {
                  setProvider(value);
                  setValues({});
                }}
              />
            )}
            {adding && chosen?.description && (
              <Text tone="muted" size="sm">
                {chosen.description}
              </Text>
            )}
            {(adding || ask.kind === "location") && (
              <Fields
                fields={fields}
                values={values}
                set={set}
                changing={ask.kind === "location"}
              />
            )}
            {ask.kind === "location" && ask.location.account && (
              <Text tone="muted" size="sm">
                {ask.location.account}
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
              {ask.kind === "location" && chosen?.sign_in && (
                <Button
                  title="Sign in again"
                  busy={signIn.busy}
                  onPress={() =>
                    void signIn
                      .run({ id: ask.location.id })
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
