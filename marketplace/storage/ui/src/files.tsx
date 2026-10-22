import { useEffect, useState } from "react";
import {
  Button,
  DropZone,
  Empty,
  FileButton,
  Icon,
  IconButton,
  List,
  ListItem,
  Page,
  Spinner,
  Split,
  Stack,
  Table,
  Tabs,
  Text,
  useAction,
  useActionResult,
  useChooseChat,
  useCopy,
  useDownload,
  useEvent,
  useUpload,
} from "@zerolux/ui";
import type { Crumb, MenuEntry, PickedFile, TableRow } from "@zerolux/ui";
import { Asking, type Ask } from "./parts/asking";
import {
  fileIcon,
  kind,
  leaf,
  parent,
  providerIcon,
  size,
  sorted,
  state,
  when,
  type Entry,
  type Location,
  type Sort,
} from "./parts/files";
import { Where } from "./parts/where";

/** Moving or copying what is chosen: where to, asked in a walk of the locations. */
interface Carry {
  kind: "move" | "copy";
  entries: Entry[];
}

const sorts: { key: Sort["key"]; title: string }[] = [
  { key: "name", title: "Name" },
  { key: "kind", title: "Kind" },
  { key: "size", title: "Size" },
  { key: "modified", title: "Modified" },
];

/**
 * The workspace's files where they are, as a screen of the app: the locations at the side;
 * where you are, the search and what you can do on top; the folder's files in a table you
 * choose in, with what is chosen beside it. A right click, or a long press, does what the
 * rows offer; files dragged in upload, and rows dragged onto a folder or a location move.
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
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>({ key: "name" });
  const [view, setView] = useState<"list" | "icons">("list");
  const [ask, setAsk] = useState<Ask>();
  const [carry, setCarry] = useState<Carry>();
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
  const move = useAction("move");
  const copy = useAction("copy");
  const share = useAction("share");
  const copyText = useCopy();
  const chooseChat = useChooseChat();
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
  // What was chosen is let go where something else shows.
  useEffect(() => setSelected([]), [at, folder, searching]);

  const can = (capability: string) =>
    location?.capabilities.includes(capability) ?? false;
  const shown = searching ? found : location ? listing : undefined;
  const entries = sorted(
    (shown?.data?.entries ?? []).filter(
      (entry) => !entry.location || entry.location === at,
    ),
    sort,
  );
  const picked = entries.filter((entry) => selected.includes(entry.path));
  const problem = location ? state(location) : "";
  const writable = can("write") && !problem;
  const open = (entry: Entry) =>
    entry.kind === "folder"
      ? (setQuery(""), setFolder(entry.path))
      : void download.download({ location: at, path: entry.path });
  const send = async (files: PickedFile[]) => {
    for (const { file, name } of files)
      await upload
        .upload(file, name, { location: at, path: folder })
        .catch(() => {});
    reload();
  };
  /** Moves or copies paths of this location into a folder, here or in another location. */
  const carryTo = async (
    how: "move" | "copy",
    paths: string[],
    toLocation: string,
    to: string,
  ) => {
    const action = how === "move" ? move : copy;
    for (const path of paths)
      if (!(toLocation === at && (parent(path) === to || path === to)))
        await action.run({ location: at, path, to_location: toLocation, to });
    setSelected([]);
    reload();
  };
  const error =
    (problem ? "" : shown?.error) ||
    upload.error ||
    download.error ||
    move.error ||
    copy.error ||
    share.error;

  /** What can be done with these entries: one, or all those chosen. */
  /** Where something is: its full path in a folder location, else the location's name and path. */
  const pathOf = (path: string) =>
    location?.provider === "folder" && location.config.path
      ? [String(location.config.path), path].filter(Boolean).join("/")
      : [location?.name, path].filter(Boolean).join("/");
  /** Shares files in a chat the person chooses. */
  const shareIn = async (files: Entry[]) => {
    const [only] = files;
    const chat = await chooseChat(
      files.length === 1 && only
        ? `Share ${only.name} in a chat`
        : `Share ${files.length} files in a chat`,
    );
    if (!chat) return;
    for (const file of files)
      await share
        .run({ location: at, path: file.path, conversation_id: chat })
        .catch(() => {});
  };
  const actions = (these: Entry[]): MenuEntry[] => {
    const [only] = these;
    const files = these.filter((entry) => entry.kind === "file");
    return [
      ...(these.length === 1 && only
        ? [
            {
              title: "Open",
              icon: only.kind === "folder" ? "folder-open" : "external-link",
              onPress: () => open(only),
            },
          ]
        : []),
      ...(files.length === these.length && files.length
        ? [
            {
              title: "Share in a chat…",
              icon: "message-square-share",
              onPress: () => void shareIn(files),
            },
          ]
        : []),
      ...(these.length ? [{ divider: true as const }] : []),
      ...(writable && these.length === 1 && only
        ? [
            {
              title: "Rename",
              icon: "pencil",
              onPress: () =>
                setAsk({ kind: "rename", location: at, entry: only }),
            },
          ]
        : []),
      ...(writable
        ? [
            {
              title: "Move to…",
              icon: "folder-input",
              shortcut: "⇧⌘M",
              onPress: () => setCarry({ kind: "move", entries: these }),
            },
          ]
        : []),
      {
        title: "Copy to…",
        icon: "copy",
        onPress: () => setCarry({ kind: "copy", entries: these }),
      },
      ...(these.length === 1 && only
        ? [
            {
              title: "Copy path",
              icon: "link",
              shortcut: "⌥⌘C",
              onPress: () => void copyText(pathOf(only.path)),
            },
          ]
        : []),
      ...(files.length
        ? [
            { divider: true as const },
            {
              title:
                files.length === 1
                  ? "Download"
                  : `Download ${files.length} files`,
              icon: "download",
              onPress: () => {
                for (const file of files)
                  void download.download({ location: at, path: file.path });
              },
            },
          ]
        : []),
      ...(can("delete") && !problem
        ? [
            { divider: true as const },
            {
              title: "Delete",
              icon: "trash-2",
              tone: "danger" as const,
              shortcut: "⌘⌫",
              onPress: () =>
                setAsk({ kind: "delete", location: at, entries: these }),
            },
          ]
        : []),
    ];
  };

  const sortMenu: MenuEntry = {
    title: "Sort by",
    icon: "arrow-up-down",
    items: [
      ...sorts.map((each) => ({
        title: each.title,
        checked: sort.key === each.key,
        onPress: () => setSort({ ...sort, key: each.key }),
      })),
      { divider: true as const },
      {
        title: "Ascending",
        checked: !sort.descending,
        onPress: () => setSort({ ...sort, descending: false }),
      },
      {
        title: "Descending",
        checked: Boolean(sort.descending),
        onPress: () => setSort({ ...sort, descending: true }),
      },
    ],
  };

  const locationMenu = (each: Location): MenuEntry[] => [
    {
      title: "Open",
      icon: "folder-open",
      onPress: () => (setChosen(each.id), setOpened(true)),
    },
    {
      title: "Settings",
      icon: "settings",
      onPress: () => setAsk({ kind: "location", location: each }),
    },
    ...(each.own
      ? []
      : [
          { divider: true as const },
          {
            title: "Remove",
            icon: "trash-2",
            tone: "danger" as const,
            onPress: () => setAsk({ kind: "remove-location", location: each }),
          },
        ]),
  ];

  const list =
    locations.loading && !locations.data ? (
      <Spinner />
    ) : all.length ? (
      <List>
        {all.map((each) => (
          <ListItem
            key={each.id}
            title={each.name}
            selected={each.id === at}
            subtitle={
              state(each) ||
              (each.default ? "Attachments" : each.account) ||
              undefined
            }
            leading={
              <Icon
                name={providerIcon(each.provider)}
                tone={state(each) ? "danger" : "muted"}
              />
            }
            onPress={() => (setChosen(each.id), setOpened(true))}
            menu={locationMenu(each)}
            onDrop={
              each.id !== at &&
              !state(each) &&
              each.capabilities.includes("write")
                ? (ids, copying) =>
                    void carryTo(
                      copying ? "copy" : "move",
                      ids,
                      each.id,
                      "",
                    ).catch(() => {})
                : undefined
            }
          />
        ))}
      </List>
    ) : (
      <Empty>No locations</Empty>
    );

  const path = folder ? folder.split("/") : [];
  const crumbs: Crumb[] = location
    ? [
        { title: location.name, onPress: () => setFolder("") },
        ...path.map((name, i) => ({
          title: name,
          onPress: () => setFolder(path.slice(0, i + 1).join("/")),
        })),
      ]
    : [{ title: "Files" }];

  const rows: TableRow[] = entries.map((entry) => ({
    id: entry.path,
    icon: fileIcon(entry),
    cells: {
      name:
        view === "icons" ? (
          <Text>{entry.name}</Text>
        ) : (
          <Stack direction="row" gap={10} align="center">
            <Icon name={fileIcon(entry)} tone="muted" />
            <Text>{entry.name}</Text>
          </Stack>
        ),
      where: (
        <Text tone="muted">
          {parent(entry.path) ? parent(entry.path) : location?.name}
        </Text>
      ),
      kind: <Text tone="muted">{kind(entry)}</Text>,
      size: (
        <Text tone="muted" mono>
          {entry.kind === "file" && entry.size !== undefined
            ? size(entry.size)
            : "—"}
        </Text>
      ),
      modified: (
        <Text tone="muted">{entry.modified ? when(entry.modified) : ""}</Text>
      ),
    },
    onOpen: () => open(entry),
    menu: actions(
      selected.includes(entry.path) && picked.length > 1 ? picked : [entry],
    ),
    drag: writable ? entry.path : undefined,
    onDrop:
      writable && entry.kind === "folder"
        ? (ids, copying) =>
            void carryTo(copying ? "copy" : "move", ids, at, entry.path).catch(
              () => {},
            )
        : undefined,
  }));

  const [one] = picked;
  const inspector =
    picked.length === 1 && one
      ? {
          title: one.name,
          onClose: () => setSelected([]),
          content: (
            <Stack gap={16}>
              <Stack gap={8}>
                {[
                  ["Kind", kind(one)],
                  one.kind === "file" && one.size !== undefined
                    ? ["Size", size(one.size)]
                    : null,
                  one.modified ? ["Modified", when(one.modified)] : null,
                  [
                    "Where",
                    [location?.name, ...parent(one.path).split("/")]
                      .filter(Boolean)
                      .join(" › "),
                  ],
                ]
                  .filter((fact): fact is string[] => Boolean(fact))
                  .map(([label, value]) => (
                    <Stack key={label} direction="row" gap={12}>
                      <Text tone="muted" size="sm">
                        {label}
                      </Text>
                      <Text size="sm">{value}</Text>
                    </Stack>
                  ))}
              </Stack>
              <Stack direction="row" gap={8}>
                <Button
                  title={one.kind === "folder" ? "Open" : "Download"}
                  onPress={() => open(one)}
                />
                {one.kind === "file" ? (
                  <Button
                    title="Share in a chat"
                    variant="secondary"
                    busy={share.busy}
                    onPress={() => void shareIn([one])}
                  />
                ) : writable ? (
                  <Button
                    title="Move to…"
                    variant="secondary"
                    onPress={() => setCarry({ kind: "move", entries: [one] })}
                  />
                ) : null}
              </Stack>
            </Stack>
          ),
        }
      : undefined;

  const detail = location ? (
    <Page
      title={searching ? [...crumbs, { title: "Search" }] : crumbs}
      subtitle={
        location.provider === "folder"
          ? String(location.config.path ?? "")
          : location.account || undefined
      }
      search={
        can("search")
          ? {
              placeholder: `Search ${location.name}`,
              value: query,
              onChange: setQuery,
            }
          : undefined
      }
      actions={
        <>
          <Tabs
            items={[
              { value: "list", label: "List" },
              { value: "icons", label: "Icons" },
            ]}
            value={view}
            onChange={(value) => setView(value === "icons" ? "icons" : "list")}
          />
          {writable ? (
            <>
              <Button
                title="New folder"
                variant="secondary"
                onPress={() =>
                  setAsk({ kind: "new-folder", location: at, folder })
                }
              />
              <FileButton
                title="Upload"
                variant="primary"
                multiple
                busy={upload.busy}
                onFiles={(files) => void send(files)}
              />
            </>
          ) : null}
        </>
      }
      inspector={inspector}
      menu={[
        ...(writable
          ? [
              {
                title: "New folder",
                icon: "folder-plus",
                shortcut: "⇧⌘N",
                onPress: () =>
                  setAsk({ kind: "new-folder", location: at, folder }),
              },
              {
                title: "Upload files…",
                icon: "upload",
                multiple: true,
                onFiles: (files: PickedFile[]) => void send(files),
              },
              { divider: true as const },
            ]
          : []),
        { section: "View" },
        {
          title: "As list",
          checked: view === "list",
          onPress: () => setView("list"),
        },
        {
          title: "As icons",
          checked: view === "icons",
          onPress: () => setView("icons"),
        },
        { divider: true as const },
        sortMenu,
        {
          title: `Copy path of “${leaf(folder) || location.name}”`,
          icon: "link",
          onPress: () => void copyText(pathOf(folder)),
        },
        ...(folder
          ? [
              {
                title: `Up to ${leaf(parent(folder)) || location.name}`,
                icon: "corner-left-up",
                onPress: () => setFolder(parent(folder)),
              },
            ]
          : []),
      ]}
    >
      <DropZone
        label={`Upload to ${leaf(folder) || location.name}`}
        disabled={!writable}
        onFiles={(files) => void send(files)}
      >
        <Stack gap={12}>
          {problem ? (
            <Stack gap={8} align="start">
              <Text tone="danger">{problem}</Text>
              <Button
                title={
                  location.signed_in === false ? "Sign in again" : "Settings"
                }
                onPress={() => setAsk({ kind: "location", location })}
              />
            </Stack>
          ) : null}
          {error ? <Text tone="danger">{error}</Text> : null}
          {problem ? null : shown?.loading && !shown.data ? (
            <Spinner />
          ) : (
            <Table
              view={view}
              columns={[
                { key: "name", title: "Name" },
                ...(searching ? [{ key: "where", title: "Where" }] : []),
                { key: "kind", title: "Kind" },
                { key: "size", title: "Size", align: "end" as const },
                { key: "modified", title: "Modified" },
              ]}
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              selectionMenu={actions(picked)}
              sort={sort}
              onSort={(next) =>
                setSort({
                  key: next.key as Sort["key"],
                  descending: next.descending,
                })
              }
              empty={searching ? "No files match" : "No files"}
            />
          )}
        </Stack>
      </DropZone>
    </Page>
  ) : (
    <Empty>No locations</Empty>
  );

  return (
    <>
      <Split
        label="Locations"
        actions={
          <IconButton
            icon="plus"
            label="Add location"
            onPress={() => setAsk({ kind: "add-location" })}
          />
        }
        list={list}
        detail={detail}
        open={opened && Boolean(location)}
        onBack={() => setOpened(false)}
      />
      <Asking ask={ask} close={() => setAsk(undefined)} done={reload} />
      <Where
        open={carry !== undefined}
        title={
          carry
            ? `${carry.kind === "move" ? "Move" : "Copy"} ${
                carry.entries.length === 1
                  ? carry.entries[0]!.name
                  : `${carry.entries.length} items`
              }`
            : ""
        }
        about={
          location ? `From ${[location.name, ...path].join(" › ")}` : undefined
        }
        submit={carry?.kind === "copy" ? "Copy here" : "Move here"}
        locations={all}
        start={{ location: at, folder }}
        busy={move.busy || copy.busy}
        error={move.error || copy.error || undefined}
        onChoose={(toLocation, to) => {
          if (!carry) return;
          void carryTo(
            carry.kind,
            carry.entries.map((entry) => entry.path),
            toLocation,
            to,
          ).then(
            () => setCarry(undefined),
            () => {},
          );
        }}
        onClose={() => setCarry(undefined)}
      />
    </>
  );
}
