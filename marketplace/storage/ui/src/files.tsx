import { useEffect, useState } from "react";
import {
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
  Split,
  Stack,
  Text,
  useActionResult,
  useDownload,
  useEvent,
  useUpload,
} from "@zerolux/ui";
import type { MenuItem, PickedFile } from "@zerolux/ui";
import { Asking, type Ask } from "./parts/asking";
import {
  fileIcon,
  providerIcon,
  size,
  state,
  when,
  type Entry,
  type Location,
} from "./parts/files";

/**
 * The workspace's files where they are: each location as its service holds it, live, folder
 * by folder or searched by name; uploaded by picking or dropping, and downloaded, renamed,
 * moved, copied and deleted there. Locations are added, changed and removed here too.
 */
export default function Files() {
  const locations = useActionResult<{ locations: Location[] }>("locations", {});
  const all = locations.data?.locations ?? [];
  const [chosen, setChosen] = useState("");
  // On a phone, whether a location is open instead of the list of them.
  const [opened, setOpened] = useState(false);
  const location =
    all.find((l) => l.id === chosen) ?? all.find((l) => l.default) ?? all[0];
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState<Ask>();
  const searching = query.trim() !== "";
  const at = location?.id ?? "";
  const listing = useActionResult<{ entries: Entry[] }>(
    "list",
    location && !searching ? { location: at, path: folder } : { location: "" },
  );
  const found = useActionResult<{ entries: Entry[] }>(
    "search",
    searching ? { query: query.trim(), location: at } : { query: "" },
  );
  const upload = useUpload("upload");
  const download = useDownload("download");
  // What this view changes, and what changes elsewhere, it reads again.
  const reload = () => {
    void locations.reload();
    void listing.reload();
    if (searching) void found.reload();
  };
  useEvent("changed", reload);
  // Another location opens at its top.
  useEffect(() => {
    setFolder("");
    setQuery("");
  }, [at]);

  const can = (capability: string) =>
    location?.capabilities.includes(capability) ?? false;
  const shown = searching ? found : location ? listing : undefined;
  const entries = (shown?.data?.entries ?? []).filter(
    (entry) => !entry.location || entry.location === at,
  );
  const path = folder ? folder.split("/") : [];
  const problem = location ? state(location) : "";
  const send = async (picked: PickedFile[]) => {
    for (const { file, name } of picked)
      await upload
        .upload(file, name, { location: at, path: folder })
        .catch(() => {});
    reload();
  };
  const error = (problem ? "" : shown?.error) || upload.error || download.error;
  const actions = (entry: Entry): MenuItem[] => [
    ...(entry.kind === "file"
      ? [
          {
            title: "Download",
            icon: "download",
            onPress: () =>
              void download.download({ location: at, path: entry.path }),
          },
        ]
      : []),
    ...(can("write")
      ? [
          {
            title: "Rename",
            icon: "pencil",
            onPress: () => setAsk({ kind: "rename", location: at, entry }),
          },
          {
            title: "Move",
            icon: "folder-input",
            onPress: () => setAsk({ kind: "move", location: at, entry }),
          },
        ]
      : []),
    {
      title: "Copy",
      icon: "copy",
      onPress: () => setAsk({ kind: "copy", location: at, entry }),
    },
    ...(can("delete")
      ? [
          {
            title: "Delete",
            icon: "trash-2",
            tone: "danger" as const,
            onPress: () => setAsk({ kind: "delete", location: at, entry }),
          },
        ]
      : []),
  ];

  const locationActions = (location: Location): MenuItem[] => [
    {
      title: "Settings",
      icon: "settings",
      onPress: () => setAsk({ kind: "location", location }),
    },
    ...(location.own
      ? []
      : [
          {
            title: "Remove",
            icon: "trash-2",
            tone: "danger" as const,
            onPress: () => setAsk({ kind: "remove-location", location }),
          },
        ]),
  ];

  const list = (
    <Stack gap={8}>
      {locations.loading && !locations.data ? (
        <Spinner />
      ) : all.length ? (
        <List>
          {all.map((each) => (
            <ListItem
              key={each.id}
              title={each.name}
              selected={each.id === at}
              subtitle={state(each) || each.account || undefined}
              leading={
                <Icon
                  name={providerIcon(each.provider)}
                  tone={state(each) ? "danger" : "muted"}
                />
              }
              onPress={() => {
                setChosen(each.id);
                setOpened(true);
              }}
              accessory={
                <Menu label="Location actions" items={locationActions(each)} />
              }
            />
          ))}
        </List>
      ) : (
        <Empty>No locations</Empty>
      )}
      <Button
        title="Add location"
        onPress={() => setAsk({ kind: "add-location" })}
      />
    </Stack>
  );

  const detail = location ? (
    <DropZone
      label="Drop to upload"
      disabled={!can("write") || Boolean(problem)}
      onFiles={(picked) => void send(picked)}
    >
      <Stack gap={12}>
        {problem && (
          <Stack direction="row" gap={8} align="center">
            <Text tone="danger">{problem}</Text>
            <Button
              title="Settings"
              variant="ghost"
              onPress={() => setAsk({ kind: "location", location })}
            />
          </Stack>
        )}
        {!searching && (
          <Stack direction="row" gap={4} align="center">
            <Button
              title={location.name}
              variant="ghost"
              onPress={() => setFolder("")}
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
          {can("search") && (
            <Input
              value={query}
              onChange={setQuery}
              placeholder={`Search ${location.name}`}
            />
          )}
          {can("write") && (
            <Button
              title="New folder"
              onPress={() =>
                setAsk({ kind: "new-folder", location: at, folder })
              }
            />
          )}
          {can("write") && (
            <FileButton
              title="Upload"
              variant="primary"
              multiple
              busy={upload.busy}
              onFiles={(picked) => void send(picked)}
            />
          )}
        </Stack>
        {error && <Text tone="danger">{error}</Text>}
        {shown?.loading && !shown.data ? (
          <Spinner />
        ) : entries.length ? (
          <List>
            {entries.map((entry) => (
              <ListItem
                key={entry.path}
                title={entry.name}
                subtitle={[
                  searching &&
                    entry.path.includes("/") &&
                    entry.path.slice(0, entry.path.lastIndexOf("/")),
                  entry.kind === "file" &&
                    entry.size !== undefined &&
                    size(entry.size),
                  entry.modified && when(entry.modified),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                leading={<Icon name={fileIcon(entry)} />}
                onPress={() =>
                  entry.kind === "folder"
                    ? (setQuery(""), setFolder(entry.path))
                    : void download.download({ location: at, path: entry.path })
                }
                accessory={<Menu label="Actions" items={actions(entry)} />}
              />
            ))}
          </List>
        ) : problem ? null : (
          <Empty>{searching ? "No files match" : "No files"}</Empty>
        )}
      </Stack>
    </DropZone>
  ) : (
    <Empty>No locations</Empty>
  );

  return (
    <>
      <Split
        label="Locations"
        list={list}
        detail={detail}
        open={opened && Boolean(location)}
        onBack={() => setOpened(false)}
      />
      <Asking
        ask={ask}
        locations={all}
        close={() => setAsk(undefined)}
        done={reload}
      />
    </>
  );
}
