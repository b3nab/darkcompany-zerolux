import { useEffect, useState } from "react";
import {
  Avatar,
  Button,
  DropZone,
  Empty,
  FileButton,
  Icon,
  Input,
  List,
  ListItem,
  Menu,
  Spinner,
  Stack,
  Tabs,
  Text,
  useActionResult,
  useActors,
  useDownload,
  useEvent,
  useUpload,
} from "@zerolux/ui";
import type { PickedFile } from "@zerolux/ui";
import { Asking, parent } from "./parts/asking";
import type { Ask } from "./parts/asking";
import {
  fileIcon,
  size,
  subfolders,
  when,
  within,
  type StoredFile,
} from "./parts/files";

type Who = "all" | "people" | "agents";

/**
 * The workspace's files, as a person finds them: folder by folder, or by name across all of
 * them; uploaded by picking or dropping them, and downloaded, renamed, moved and deleted.
 */
export default function Files() {
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [who, setWho] = useState<Who>("all");
  const [ask, setAsk] = useState<Ask>();
  const searching = query.trim() !== "";
  const files = useActionResult<{ files: StoredFile[] }>(
    "files",
    searching ? {} : { folder },
  );
  const folders = useActionResult<{ folders: string[] }>("folders", {});
  useEvent("changed", () => reload());
  const actors = useActors();
  const upload = useUpload("upload");
  const download = useDownload("download");
  const kind = (file: StoredFile) =>
    actors.find((actor) => actor.id === file.created_by)?.kind;
  const words = query.trim().toLowerCase();
  const shown = (files.data?.files ?? []).filter(
    (file) =>
      (who === "all" ||
        kind(file) === (who === "people" ? "human" : "agent")) &&
      (!searching || file.name.toLowerCase().includes(words)),
  );
  // The folder open, gone because it was renamed, moved or deleted, here or by someone else,
  // gives way to the nearest one still there.
  const known = folders.data?.folders;
  useEffect(() => {
    if (!known || !folder || known.includes(folder)) return;
    let up = parent(folder);
    while (up && !known.includes(up)) up = parent(up);
    setFolder(up);
  }, [known, folder]);
  const inside = searching
    ? []
    : subfolders(folders.data?.folders ?? [], folder);
  const path = folder ? folder.split("/") : [];

  // One file after another, into the folder open now.
  // What this view changes it reads again at once, not only when the notice comes.
  const reload = () => {
    void files.reload();
    void folders.reload();
  };
  const send = async (picked: PickedFile[]) => {
    for (const { file, name } of picked)
      await upload.upload(file, name, { folder }).catch(() => {});
    reload();
  };
  const error = files.error || upload.error || download.error;

  return (
    <DropZone label="Drop to upload" onFiles={(picked) => void send(picked)}>
      <Stack gap={12}>
        {folder && (
          <Stack direction="row" gap={4} align="center">
            <Button
              title="Files"
              variant="ghost"
              onPress={() => {
                setFolder("");
                setQuery("");
              }}
            />
            {path.map((name, i) => (
              <Stack key={i} direction="row" gap={4} align="center">
                <Text tone="muted">/</Text>
                <Button
                  title={name}
                  variant="ghost"
                  onPress={() => setFolder(path.slice(0, i + 1).join("/"))}
                />
              </Stack>
            ))}
          </Stack>
        )}
        <Stack direction="row" gap={8} align="center">
          <Tabs
            value={who}
            onChange={(value) => setWho(value as Who)}
            items={[
              { value: "all", label: "All" },
              { value: "people", label: "People" },
              { value: "agents", label: "Agents" },
            ]}
          />
          <Button
            title="New folder"
            onPress={() => setAsk({ kind: "new-folder", folder })}
          />
          <FileButton
            title="Upload"
            variant="primary"
            multiple
            busy={upload.busy}
            onFiles={(picked) => void send(picked)}
          />
        </Stack>
        <Input value={query} onChange={setQuery} placeholder="Search files" />
        {error && <Text tone="danger">{error}</Text>}
        {files.loading && !files.data ? (
          <Spinner />
        ) : inside.length || shown.length ? (
          <List>
            {inside.map((name) => {
              const at = within(folder, name);
              return (
                <ListItem
                  key={`folder:${at}`}
                  title={name}
                  leading={<Icon name="folder" />}
                  onPress={() => setFolder(at)}
                  accessory={
                    <Menu
                      label="Folder actions"
                      items={[
                        {
                          title: "Rename",
                          icon: "pencil",
                          onPress: () =>
                            setAsk({ kind: "rename-folder", folder: at }),
                        },
                        {
                          title: "Move",
                          icon: "folder-input",
                          onPress: () =>
                            setAsk({ kind: "move-folder", folder: at }),
                        },
                        {
                          title: "Delete",
                          icon: "trash-2",
                          tone: "danger",
                          onPress: () =>
                            setAsk({ kind: "delete-folder", folder: at }),
                        },
                      ]}
                    />
                  }
                />
              );
            })}
            {shown.map((file) => (
              <ListItem
                key={file.id}
                title={file.name}
                subtitle={[
                  searching && file.folder,
                  size(file.size),
                  when(file.updated_at),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                leading={<Icon name={fileIcon(file)} />}
                onPress={() => void download.download({ id: file.id })}
                accessory={
                  <Stack direction="row" gap={8} align="center">
                    <Avatar actorId={file.created_by} size="sm" />
                    <Menu
                      label="File actions"
                      items={[
                        {
                          title: "Download",
                          icon: "download",
                          onPress: () =>
                            void download.download({ id: file.id }),
                        },
                        {
                          title: "Rename",
                          icon: "pencil",
                          onPress: () => setAsk({ kind: "rename", file }),
                        },
                        {
                          title: "Move",
                          icon: "folder-input",
                          onPress: () => setAsk({ kind: "move", file }),
                        },
                        {
                          title: "Delete",
                          icon: "trash-2",
                          tone: "danger",
                          onPress: () => setAsk({ kind: "delete", file }),
                        },
                      ]}
                    />
                  </Stack>
                }
              />
            ))}
          </List>
        ) : (
          <Empty>{searching ? "No files match" : "No files"}</Empty>
        )}
      </Stack>
      <Asking
        ask={ask}
        folders={folders.data?.folders ?? []}
        close={() => setAsk(undefined)}
        done={reload}
      />
    </DropZone>
  );
}
