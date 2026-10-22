import { useState } from "react";
import {
  Button,
  DateInput,
  Input,
  Select,
  Sheet,
  Stack,
  Text,
  useAction,
} from "@zerolux/ui";
import { useAssignees, useTracked } from "./task-sheet";
import { priorities, statuses, tap } from "./model";
import type { Priority, Project, Status } from "./model";

/** Where a new task starts: its project, state and assignee, when the place says. */
export interface Start {
  project?: string;
  status?: Status;
  assignee?: string;
}

const blank = (start: Start, projects: Project[]) => ({
  project_id: start.project ?? projects[0]?.id ?? "",
  title: "",
  description: "",
  status: start.status ?? ("backlog" as Status),
  priority: "none" as Priority,
  assignee: start.assignee ?? "",
  due: null as string | null,
});

/**
 * A new task: its title first, the rest as it starts where it was asked for. The project is
 * chosen only where the place does not say it.
 */
export function NewTask({
  start,
  projects,
  onCreated,
  onClose,
}: {
  start: Start | undefined;
  projects: Project[];
  onCreated: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={start !== undefined} onClose={onClose} title="New task">
      {start ? (
        <Form
          start={start}
          projects={projects}
          onDone={() => {
            onCreated();
            onClose();
          }}
        />
      ) : null}
    </Sheet>
  );
}

function Form({
  start,
  projects,
  onDone,
}: {
  start: Start;
  projects: Project[];
  onDone: () => void;
}) {
  const create = useAction("create_task");
  const [task, setTask] = useState(() => blank(start, projects));
  const chosen = projects.find((p) => p.id === task.project_id);
  const { tracked } = useTracked(chosen?.source);
  const assignees = useAssignees(tracked);
  const set = (fields: Partial<typeof task>) =>
    setTask((was) => ({ ...was, ...fields }));
  const save = () =>
    tap(create.run({ ...task, assignee: task.assignee || null }).then(onDone));
  return (
    <Stack gap={12}>
      {start.project ? null : (
        <Select
          label="Project"
          value={task.project_id}
          options={projects.map((p) => ({
            value: p.id,
            label: p.key ? `${p.name} · ${p.key}` : p.name,
          }))}
          onChange={(project_id) => set({ project_id })}
        />
      )}
      <Input
        label="Title"
        value={task.title}
        onChange={(title) => set({ title })}
        autoFocus
      />
      <Input
        label="Description"
        multiline
        value={task.description}
        onChange={(description) => set({ description })}
      />
      <Select
        label="Status"
        value={task.status}
        options={statuses}
        onChange={(status) => set({ status: status as Status })}
      />
      <Select
        label="Priority"
        value={task.priority}
        options={priorities}
        onChange={(priority) => set({ priority: priority as Priority })}
      />
      <Select
        label={tracked ? "Agent" : "Assignee"}
        value={task.assignee}
        options={assignees}
        onChange={(assignee) => set({ assignee })}
      />
      <DateInput
        label="Due"
        value={task.due}
        onChange={(due) => set({ due })}
      />
      {create.error ? <Text tone="danger">{create.error}</Text> : null}
      <Button
        title="Create"
        busy={create.busy}
        disabled={!task.title.trim() || !task.project_id}
        onPress={save}
      />
    </Stack>
  );
}
