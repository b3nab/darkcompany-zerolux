import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  DateInput,
  Divider,
  Heading,
  Icon,
  Input,
  List,
  ListItem,
  Markdown,
  Menu,
  Select,
  Sheet,
  Spinner,
  Stack,
  Text,
  useAction,
  useActionResult,
  useActors,
  useEvent,
} from "@zerolux/ui";
import { priorities, statuses, tap, when } from "./model";
import type { Source, Task } from "./model";

/** How long typing rests before what was typed is kept. */
const REST = 800;

/**
 * Choosing who does a task: nobody, or a person or an agent of the workspace. In a tracker,
 * people are given tasks there: here only an agent.
 */
export function useAssignees(tracked = false) {
  const actors = useActors();
  return [
    { value: "", label: "No one" },
    ...actors
      .filter((actor) => !tracked || actor.kind === "agent")
      .map((actor) => ({ value: actor.id, label: actor.name })),
  ];
}

/** Whether a source is a tracker's rather than ZeroLux's own. */
export function useTracked(source: string | undefined) {
  const sources = useActionResult<{ sources: Source[] }>("sources", {});
  const found = sources.data?.sources.find((s) => s.id === source);
  return { tracked: found ? found.tracker !== "local" : false, source: found };
}

/** The labels a task carries, chosen among those the work uses, or a new one. */
function Labels({
  open,
  onClose,
  chosen,
  known,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  chosen: string[];
  known: string[];
  onChange: (labels: string[]) => void;
}) {
  const [added, setAdded] = useState("");
  const all = [...new Set([...known, ...chosen])];
  const toggle = (label: string) =>
    onChange(
      chosen.includes(label)
        ? chosen.filter((l) => l !== label)
        : [...chosen, label],
    );
  const add = () => {
    const label = added.trim();
    if (label && !chosen.includes(label)) onChange([...chosen, label]);
    setAdded("");
  };
  return (
    <Sheet open={open} onClose={onClose} title="Labels">
      {all.length ? (
        <List>
          {all.map((label) => (
            <ListItem
              key={label}
              title={label}
              accessory={
                chosen.includes(label) ? (
                  <Icon name="check" size={18} tone="default" />
                ) : undefined
              }
              onPress={() => toggle(label)}
            />
          ))}
        </List>
      ) : null}
      <Stack direction="row" gap={8}>
        <Input
          value={added}
          onChange={setAdded}
          placeholder="New label"
          onSubmit={add}
        />
        <Button title="Add" disabled={!added.trim()} onPress={add} />
      </Stack>
    </Sheet>
  );
}

/** A task read on its own, with its comments: every property changes as it is chosen. */
export function TaskDetail({
  id,
  known,
  onChanged,
  onGone,
}: {
  id: string;
  known: string[];
  onChanged: () => void;
  onGone: () => void;
}) {
  const read = useActionResult<Task>("task", { id });
  useEvent("changed", () => void read.reload());
  // What it changed shows at once, without waiting for the event.
  const changed = () => {
    void read.reload();
    onChanged();
  };
  const update = useAction("update_task");
  const comment = useAction("comment");
  const remove = useAction("delete_task");
  const actors = useActors();
  const { tracked, source } = useTracked(read.data?.source);
  const assignees = useAssignees(tracked);
  // What is typed, kept once typing rests, and let go once kept as it is.
  const [draft, setDraft] = useState<{ title: string; description: string }>();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");
  const [labels, setLabels] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const task = read.data;
  useEffect(() => {
    if (!draft || !task) return;
    // Kept, and read back as typed: the draft goes.
    if (draft.title === task.title && draft.description === task.description)
      return setDraft(undefined);
    if (!draft.title.trim()) return;
    const timer = setTimeout(
      () => tap(update.run({ id, ...draft }).then(changed)),
      REST,
    );
    return () => clearTimeout(timer);
    // The task is read for what it says, not for being read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, task?.title, task?.description]);
  // What is typed and not yet kept is kept when the task closes.
  const unkept = useRef(draft);
  unkept.current =
    draft &&
    task &&
    draft.title.trim() &&
    (draft.title !== task.title || draft.description !== task.description)
      ? draft
      : undefined;
  const save = update.run;
  useEffect(
    () => () => {
      if (unkept.current) tap(save({ id, ...unkept.current }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  if (!task)
    return read.error ? <Text tone="danger">{read.error}</Text> : <Spinner />;
  const change = (fields: Partial<Task>) =>
    tap(update.run({ id, ...fields }).then(changed));
  const name = (actor: string | null, author?: string | null) =>
    actors.find((a) => a.id === actor)?.name ?? author ?? "Someone";
  const capable = (capability: string) =>
    !tracked || Boolean(source?.capabilities?.includes(capability));
  const send = () =>
    tap(
      comment.run({ id, text: note }).then(() => {
        setNote("");
        changed();
      }),
    );
  return (
    <Stack gap={16}>
      <Stack gap={8}>
        <Input
          value={draft?.title ?? task.title}
          onChange={(title) =>
            setDraft({
              title,
              description: draft?.description ?? task.description,
            })
          }
          placeholder="Title"
        />
        {writing ? (
          <Input
            multiline
            value={draft?.description ?? task.description}
            onChange={(description) =>
              setDraft({ title: draft?.title ?? task.title, description })
            }
            placeholder="Description"
          />
        ) : task.description ? (
          <Markdown>{task.description}</Markdown>
        ) : (
          <Text tone="muted">No description</Text>
        )}
        <Stack direction="row" gap={4}>
          <Button
            title={writing ? "Done" : "Edit description"}
            variant="secondary"
            onPress={() => setWriting(!writing)}
          />
          {capable("delete") ? (
            <Menu
              label="More"
              items={[
                {
                  title: "Delete task",
                  icon: "trash-2",
                  tone: "danger",
                  onPress: () => setDeleting(true),
                },
              ]}
            />
          ) : null}
        </Stack>
      </Stack>
      {deleting ? (
        <Stack direction="row" gap={8}>
          <Button
            title={`Delete ${task.key}`}
            variant="danger"
            busy={remove.busy}
            onPress={() =>
              tap(
                remove.run({ id }).then(() => {
                  onChanged();
                  onGone();
                }),
              )
            }
          />
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => setDeleting(false)}
          />
        </Stack>
      ) : null}
      {update.error || remove.error ? (
        <Text tone="danger">{update.error || remove.error}</Text>
      ) : null}
      <Divider />
      <Stack gap={12}>
        <Select
          label="Status"
          value={task.status}
          options={statuses}
          onChange={(status) => change({ status: status as Task["status"] })}
        />
        <Select
          label="Priority"
          value={task.priority}
          options={priorities}
          onChange={(priority) =>
            change({ priority: priority as Task["priority"] })
          }
        />
        {tracked && task.people?.length ? (
          <Text size="sm">{task.people.join(", ")}</Text>
        ) : null}
        <Select
          label={tracked ? "Agent" : "Assignee"}
          value={task.assignee ?? ""}
          options={assignees}
          onChange={(assignee) => change({ assignee: assignee || null })}
        />
        <DateInput
          label="Due"
          value={task.due}
          onChange={(due) => change({ due })}
        />
        <Stack gap={6}>
          <Text size="sm">Labels</Text>
          <Stack direction="row" gap={6}>
            {task.labels.map((label) => (
              <Badge key={label}>{label}</Badge>
            ))}
            <Button
              title={task.labels.length ? "Change" : "Add"}
              variant="ghost"
              onPress={() => setLabels(true)}
            />
          </Stack>
        </Stack>
      </Stack>
      <Labels
        open={labels}
        onClose={() => setLabels(false)}
        chosen={task.labels}
        known={known}
        onChange={(chosen) => change({ labels: chosen })}
      />
      {task.url ? (
        <Text size="sm" mono tone="muted">
          {task.url}
        </Text>
      ) : null}
      <Divider />
      <Stack gap={12}>
        <Heading level={3}>Comments</Heading>
        {(task.comments ?? []).map((c) => (
          <Stack key={c.id} gap={4}>
            <Stack direction="row" gap={8}>
              {c.by ? <Avatar actorId={c.by} size="sm" /> : null}
              <Text size="sm">{name(c.by, c.author)}</Text>
              <Text size="sm" tone="muted">
                {when(c.at)}
              </Text>
            </Stack>
            <Markdown>{c.text}</Markdown>
          </Stack>
        ))}
        <Input
          value={note}
          onChange={setNote}
          placeholder="Write a comment"
          multiline
        />
        {comment.error ? <Text tone="danger">{comment.error}</Text> : null}
        <Button
          title="Comment"
          busy={comment.busy}
          disabled={!note.trim()}
          onPress={send}
        />
      </Stack>
    </Stack>
  );
}

/** A task, over the view: everything about it, changed in place. */
export function TaskSheet({
  task,
  known,
  onChanged,
  onClose,
}: {
  task: Task | undefined;
  known: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== undefined} onClose={onClose} title={task?.key}>
      {task ? (
        <TaskDetail
          id={task.id}
          known={known}
          onChanged={onChanged}
          onGone={onClose}
        />
      ) : null}
    </Sheet>
  );
}
