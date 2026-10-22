import { useEffect, useState } from "react";
import {
  Button,
  Empty,
  Icon,
  List,
  ListItem,
  Sheet,
  Spinner,
  Stack,
  Text,
  useActionResult,
} from "@zerolux/ui";
import {
  leaf,
  parent,
  providerIcon,
  state,
  type Entry,
  type Location,
} from "./files";

/**
 * Where to move or copy to, walked and never typed: the locations, then the folders of the
 * one opened. A location that cannot be written to, or is not ready, shows and is not offered.
 */
export function Where({
  open,
  title,
  about,
  submit,
  locations,
  start,
  busy,
  error,
  onChoose,
  onClose,
}: {
  open: boolean;
  title: string;
  /** What goes, and from where. */
  about?: string;
  submit: string;
  locations: Location[];
  /** Where the walk starts: the location and folder things are in, which is not a place to go. */
  start: { location: string; folder: string };
  busy?: boolean;
  error?: string;
  onChoose: (location: string, folder: string) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(start.location);
  const [folder, setFolder] = useState(start.folder);
  useEffect(() => {
    if (!open) return;
    setAt(start.location);
    setFolder(start.folder);
  }, [open, start.location, start.folder]);
  const listing = useActionResult<{ entries: Entry[] }>(
    "list",
    open && at ? { location: at, path: folder } : { location: "" },
  );
  const location = locations.find((each) => each.id === at);
  const folders = (listing.data?.entries ?? []).filter(
    (entry) => entry.kind === "folder",
  );
  const path = folder ? folder.split("/") : [];

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <Stack gap={12}>
        {about ? <Text tone="muted">{about}</Text> : null}
        <Stack direction="row" gap={4} align="center">
          <Button
            title="Locations"
            variant="ghost"
            onPress={() => (setAt(""), setFolder(""))}
          />
          {location ? (
            <>
              <Icon name="chevron-right" size={14} tone="muted" />
              <Button
                title={location.name}
                variant="ghost"
                onPress={() => setFolder("")}
              />
            </>
          ) : null}
          {path.map((name, i) => (
            <Stack key={i} direction="row" gap={4} align="center">
              <Icon name="chevron-right" size={14} tone="muted" />
              <Button
                title={name}
                variant="ghost"
                onPress={() => setFolder(path.slice(0, i + 1).join("/"))}
              />
            </Stack>
          ))}
        </Stack>
        {!location ? (
          <List>
            {locations.map((each) => {
              const problem =
                state(each) ||
                (each.capabilities.includes("write") ? "" : "Read only");
              return (
                <ListItem
                  key={each.id}
                  title={each.name}
                  subtitle={problem || undefined}
                  leading={
                    <Icon name={providerIcon(each.provider)} tone="muted" />
                  }
                  accessory={
                    problem ? undefined : (
                      <Icon name="chevron-right" size={14} tone="muted" />
                    )
                  }
                  onPress={
                    problem ? undefined : () => (setAt(each.id), setFolder(""))
                  }
                />
              );
            })}
          </List>
        ) : listing.loading && !listing.data ? (
          <Spinner />
        ) : listing.error ? (
          <Text tone="danger">{listing.error}</Text>
        ) : folders.length ? (
          <List>
            {folder ? (
              <ListItem
                title={leaf(parent(folder)) || location.name}
                leading={<Icon name="corner-left-up" tone="muted" />}
                onPress={() => setFolder(parent(folder))}
              />
            ) : null}
            {folders.map((entry) => (
              <ListItem
                key={entry.path}
                title={entry.name}
                leading={<Icon name="folder" tone="muted" />}
                accessory={<Icon name="chevron-right" size={14} tone="muted" />}
                onPress={() => setFolder(entry.path)}
              />
            ))}
          </List>
        ) : (
          <Empty>No folders</Empty>
        )}
        {error ? <Text tone="danger">{error}</Text> : null}
        <Stack direction="row" gap={8}>
          <Button
            title={submit}
            variant="primary"
            busy={busy}
            disabled={
              !location || (at === start.location && folder === start.folder)
            }
            onPress={() => onChoose(at, folder)}
          />
          <Button title="Cancel" variant="ghost" onPress={onClose} />
        </Stack>
      </Stack>
    </Sheet>
  );
}
