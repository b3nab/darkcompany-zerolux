import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Select,
  Sheet,
  Stack,
  Text,
  useAction,
} from "@zerolux/ui";
import { within, type StoredFile } from "./files";

/** What a sheet asks before something changes, and what it is about. */
export type Ask =
  | { kind: "new-folder"; folder: string }
  | { kind: "rename" | "move" | "delete"; file: StoredFile }
  | { kind: "rename-folder" | "move-folder" | "delete-folder"; folder: string };

const leaf = (folder: string) => folder.split("/").pop() ?? folder;
export const parent = (folder: string) =>
  folder.split("/").slice(0, -1).join("/");

/**
 * The sheet for one question: a name, a folder to move to, or a yes to delete. `done` follows
 * each change.
 */
export function Asking({
  ask,
  folders,
  close,
  done,
}: {
  ask: Ask | undefined;
  folders: string[];
  close: () => void;
  done: () => void;
}) {
  const create = useAction("create_folder");
  const rename = useAction("rename");
  const move = useAction("move");
  const remove = useAction("delete");
  const renameFolder = useAction("rename_folder");
  const moveFolder = useAction("move_folder");
  const removeFolder = useAction("delete_folder");
  const [text, setText] = useState("");
  const [failed, setFailed] = useState("");
  // Each question starts from what it is about.
  useEffect(() => {
    setFailed("");
    setText(
      ask?.kind === "rename"
        ? ask.file.name
        : ask?.kind === "rename-folder"
          ? leaf(ask.folder)
          : ask?.kind === "move"
            ? ask.file.folder
            : ask?.kind === "move-folder"
              ? parent(ask.folder)
              : "",
    );
  }, [ask]);
  if (!ask) return null;

  const name = text.trim();
  // Where something may go: the top, or any folder that is not itself or inside it.
  const places = (self?: string) =>
    ["", ...folders]
      .filter(
        (folder) =>
          self === undefined ||
          (folder !== self && !folder.startsWith(`${self}/`)),
      )
      .map((folder) => ({ value: folder, label: folder || "Files" }));
  const step = (() => {
    switch (ask.kind) {
      case "new-folder":
        return {
          title: "New folder",
          field: "name" as const,
          submit: "Create",
          busy: create.busy,
          go: () => create.run({ folder: within(ask.folder, name) }),
        };
      case "rename":
        return {
          title: "Rename",
          field: "name" as const,
          submit: "Rename",
          busy: rename.busy,
          go: () => rename.run({ id: ask.file.id, name }),
        };
      case "move":
        return {
          title: `Move ${ask.file.name}`,
          field: "folder" as const,
          places: places(),
          submit: "Move",
          busy: move.busy,
          go: () => move.run({ id: ask.file.id, folder: text }),
        };
      case "delete":
        return {
          title: `Delete ${ask.file.name}?`,
          submit: "Delete",
          danger: true,
          busy: remove.busy,
          go: () => remove.run({ id: ask.file.id }),
        };
      case "rename-folder":
        return {
          title: "Rename",
          field: "name" as const,
          submit: "Rename",
          busy: renameFolder.busy,
          go: () => renameFolder.run({ folder: ask.folder, name }),
        };
      case "move-folder":
        return {
          title: `Move ${leaf(ask.folder)}`,
          field: "folder" as const,
          places: places(ask.folder),
          submit: "Move",
          busy: moveFolder.busy,
          go: () => moveFolder.run({ folder: ask.folder, into: text }),
        };
      case "delete-folder":
        return {
          title: `Delete ${leaf(ask.folder)} and everything in it?`,
          submit: "Delete",
          danger: true,
          busy: removeFolder.busy,
          go: () => removeFolder.run({ folder: ask.folder }),
        };
    }
  })();
  const blocked = step.field === "name" && !name;
  const submit = () => {
    if (blocked || step.busy) return;
    setFailed("");
    step.go().then(
      () => {
        close();
        done();
      },
      (error: unknown) =>
        setFailed(error instanceof Error ? error.message : String(error)),
    );
  };

  return (
    <Sheet open onClose={close} title={step.title}>
      <Stack gap={12}>
        {step.field === "name" && (
          <Input
            value={text}
            onChange={setText}
            placeholder="Name"
            autoFocus
            onSubmit={submit}
          />
        )}
        {step.field === "folder" && (
          <Select value={text} options={step.places} onChange={setText} />
        )}
        {failed && <Text tone="danger">{failed}</Text>}
        <Stack direction="row" gap={8}>
          <Button
            title={step.submit}
            variant={step.danger ? "danger" : "primary"}
            busy={step.busy}
            disabled={blocked}
            onPress={submit}
          />
          <Button title="Cancel" variant="ghost" onPress={close} />
        </Stack>
      </Stack>
    </Sheet>
  );
}
