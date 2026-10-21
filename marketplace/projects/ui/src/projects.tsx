import { useState } from "react";
import {
  Badge,
  Button,
  Columns,
  Empty,
  Heading,
  Icon,
  IconButton,
  Input,
  List,
  ListItem,
  Menu,
  Sheet,
  Spinner,
  Stack,
  Tabs,
  Text,
  useAction,
  useActionResult,
  useEvent,
} from "@zerolux/ui";
import { byStatus, keyFrom, labelsOf, open, tap } from "./parts/model";
import type { Project, Task } from "./parts/model";
import { NewTask } from "./parts/new-task";
import type { Start } from "./parts/new-task";
import { TaskSheet } from "./parts/task-sheet";
import { StatusHeading, TaskCard, TaskRow } from "./parts/task-views";

/** A project's name, key and description, new or changed. */
function ProjectForm({
  project,
  onDone,
}: {
  project?: Project;
  onDone: () => void;
}) {
  const save = useAction(project ? "update_project" : "create_project");
  const [name, setName] = useState(project?.name ?? "");
  const [key, setKey] = useState<string>();
  const [description, setDescription] = useState(project?.description ?? "");
  // The key follows the name until it is typed.
  const shownKey = key ?? keyFrom(name);
  return (
    <Stack gap={12}>
      <Input
        label="Name"
        value={name}
        onChange={setName}
        autoFocus={!project}
      />
      {project ? null : (
        <Input
          label="Key"
          value={shownKey}
          onChange={(typed) => setKey(typed.toUpperCase())}
          placeholder="ZL"
        />
      )}
      <Input
        label="Description"
        multiline
        value={description}
        onChange={setDescription}
      />
      {save.error ? <Text tone="danger">{save.error}</Text> : null}
      <Button
        title={project ? "Save" : "Create"}
        busy={save.busy}
        disabled={!name.trim() || (!project && !shownKey)}
        onPress={() =>
          tap(
            save
              .run(
                project
                  ? { id: project.id, name, description }
                  : { name, key: shownKey, description },
              )
              .then(onDone),
          )
        }
      />
    </Stack>
  );
}

/** One project: its tasks on a board by state, or in a list by state. */
function ProjectView({
  project,
  tasks,
  known,
  projects,
  onChanged,
  onBack,
}: {
  project: Project;
  tasks: Task[];
  known: string[];
  projects: Project[];
  onChanged: () => void;
  onBack: () => void;
}) {
  const update = useAction("update_project");
  const refresh = useAction("refresh");
  const [layout, setLayout] = useState("list");
  // Done and dropped tasks stay folded until asked for.
  const [unfolded, setUnfolded] = useState(false);
  const [shown, setShown] = useState<string>();
  const [start, setStart] = useState<Start>();
  const [editing, setEditing] = useState(false);
  const groups = byStatus(tasks);
  // The board leaves out what was dropped, unless something was.
  const columns = groups.filter(
    (group) => group.value !== "cancelled" || group.tasks.length,
  );
  const show = (task: Task) => () => setShown(task.id);
  const add = (status?: Task["status"]) =>
    setStart({ project: project.id, status });
  return (
    <Stack gap={16}>
      <Stack direction="row" gap={4}>
        <IconButton icon="chevron-left" label="Projects" onPress={onBack} />
        <Heading level={2}>{project.name}</Heading>
        <Badge>{project.key}</Badge>
        {project.archived ? <Badge tone="warning">Archived</Badge> : null}
        <IconButton icon="plus" label="New task" onPress={() => add()} />
        <Menu
          label="Project"
          items={[
            {
              title: "Edit project",
              icon: "pencil",
              onPress: () => setEditing(true),
            },
            ...(project.tracker
              ? [
                  {
                    title: `Read again from ${project.tracker}`,
                    icon: "refresh-cw",
                    onPress: () =>
                      tap(
                        refresh.run({ project_id: project.id }).then(onChanged),
                      ),
                  },
                ]
              : []),
            {
              title: project.archived ? "Restore project" : "Archive project",
              icon: project.archived ? "archive-restore" : "archive",
              onPress: () =>
                tap(
                  update
                    .run({ id: project.id, archived: !project.archived })
                    .then(onChanged),
                ),
            },
          ]}
        />
      </Stack>
      {project.description ? (
        <Text tone="muted">{project.description}</Text>
      ) : null}
      {update.error || refresh.error ? (
        <Text tone="danger">{update.error || refresh.error}</Text>
      ) : null}
      <Tabs
        items={[
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ]}
        value={layout}
        onChange={setLayout}
      />
      {layout === "board" ? (
        <Columns>
          {columns.map((group) => (
            <Stack key={group.value} gap={8}>
              <StatusHeading status={group.value} count={group.tasks.length}>
                <IconButton
                  icon="plus"
                  label={`New task in ${group.label}`}
                  onPress={() => add(group.value)}
                />
              </StatusHeading>
              {group.tasks.map((task) => (
                <TaskCard key={task.id} task={task} onPress={show(task)} />
              ))}
            </Stack>
          ))}
        </Columns>
      ) : tasks.length ? (
        groups
          .filter((group) => group.tasks.length)
          .map((group) => {
            const finished =
              group.value === "done" || group.value === "cancelled";
            return (
              <Stack key={group.value} gap={8}>
                <StatusHeading status={group.value} count={group.tasks.length}>
                  {finished ? (
                    <Button
                      title={unfolded ? "Hide" : "Show"}
                      variant="ghost"
                      onPress={() => setUnfolded(!unfolded)}
                    />
                  ) : null}
                </StatusHeading>
                {finished && !unfolded ? null : (
                  <List>
                    {group.tasks.map((task) => (
                      <TaskRow key={task.id} task={task} onPress={show(task)} />
                    ))}
                  </List>
                )}
              </Stack>
            );
          })
      ) : (
        <Empty>No tasks</Empty>
      )}
      <TaskSheet
        task={tasks.find((task) => task.id === shown)}
        known={known}
        onChanged={onChanged}
        onClose={() => setShown(undefined)}
      />
      <NewTask
        start={start}
        projects={projects}
        onCreated={onChanged}
        onClose={() => setStart(undefined)}
      />
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit project"
      >
        {editing ? (
          <ProjectForm
            project={project}
            onDone={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : null}
      </Sheet>
    </Stack>
  );
}

/** A project in the list: its name, key and how much is still to do. */
function ProjectRow({
  project,
  tasks,
  onPress,
}: {
  project: Project;
  tasks: Task[];
  onPress: () => void;
}) {
  const mine = tasks.filter((task) => task.project_id === project.id);
  const left = mine.filter(open).length;
  return (
    <ListItem
      title={project.name}
      subtitle={[project.key, `${left} open`, project.tracker]
        .filter(Boolean)
        .join(" · ")}
      leading={<Icon name="kanban" />}
      onPress={onPress}
    />
  );
}

/** The workspace's projects; one opened shows its tasks. */
export default function Projects() {
  const projects = useActionResult<{ projects: Project[] }>("projects");
  const tasks = useActionResult<{ tasks: Task[] }>("tasks");
  // Read again when Projects says so, and at once after a change made here.
  const reload = () => {
    void projects.reload();
    void tasks.reload();
  };
  useEvent("changed", reload);
  const [opened, setOpened] = useState<string>();
  const [creating, setCreating] = useState(false);
  const all = projects.data?.projects ?? [];
  const work = tasks.data?.tasks ?? [];
  const project = all.find((p) => p.id === opened);
  if (project)
    return (
      <ProjectView
        project={project}
        tasks={work.filter((task) => task.project_id === project.id)}
        known={labelsOf(work)}
        projects={all}
        onChanged={reload}
        onBack={() => setOpened(undefined)}
      />
    );
  const error = projects.error || tasks.error;
  const active = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);
  return (
    <Stack gap={16}>
      <Button
        title="New project"
        variant="secondary"
        onPress={() => setCreating(true)}
      />
      {error ? <Text tone="danger">{error}</Text> : null}
      {!projects.data ? (
        error ? null : (
          <Spinner />
        )
      ) : active.length ? (
        <List>
          {active.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              tasks={work}
              onPress={() => setOpened(p.id)}
            />
          ))}
        </List>
      ) : (
        <Empty>No projects</Empty>
      )}
      {archived.length ? (
        <Stack gap={8}>
          <Text size="sm" tone="muted">
            Archived
          </Text>
          <List>
            {archived.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                tasks={work}
                onPress={() => setOpened(p.id)}
              />
            ))}
          </List>
        </Stack>
      ) : null}
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New project"
      >
        {creating ? (
          <ProjectForm
            onDone={() => {
              setCreating(false);
              reload();
            }}
          />
        ) : null}
      </Sheet>
    </Stack>
  );
}
