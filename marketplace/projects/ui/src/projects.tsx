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
  Split,
  Stack,
  Tabs,
  Text,
  useAction,
  useActionResult,
  useEvent,
} from "@zerolux/ui";
import {
  byStatus,
  can,
  keyFrom,
  labelsOf,
  open,
  sourceState,
  tap,
} from "./parts/model";
import type { Project, Source, Task } from "./parts/model";
import { SourceSheet, type SourceAsk } from "./parts/sources";
import { NewTask } from "./parts/new-task";
import type { Start } from "./parts/new-task";
import { TaskSheet } from "./parts/task-sheet";
import { StatusHeading, TaskCard, TaskRow } from "./parts/task-views";

/** A project's name, key and description, new or changed. */
function ProjectForm({
  project,
  source,
  onDone,
}: {
  project?: Project;
  source?: string;
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
                  : { source, name, key: shownKey, description },
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
  source,
  tasks,
  known,
  projects,
  onChanged,
}: {
  project: Project;
  source: Source | undefined;
  tasks: Task[];
  known: string[];
  projects: Project[];
  onChanged: () => void;
}) {
  const update = useAction("update_project");
  const editable = can(source, "edit_project");
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
        <Heading level={2}>{project.name}</Heading>
        {project.key ? <Badge>{project.key}</Badge> : null}
        {project.archived ? <Badge tone="warning">Archived</Badge> : null}
        <IconButton icon="plus" label="New task" onPress={() => add()} />
        {editable ? (
          <Menu
            label="Project"
            items={[
              {
                title: "Edit project",
                icon: "pencil",
                onPress: () => setEditing(true),
              },
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
        ) : null}
      </Stack>
      {project.url ? (
        <Text size="sm" mono tone="muted">
          {project.url}
        </Text>
      ) : null}
      {project.description ? (
        <Text tone="muted">{project.description}</Text>
      ) : null}
      {update.error ? <Text tone="danger">{update.error}</Text> : null}
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

/**
 * The workspace's projects, from every source: ZeroLux's own and each tracker's, live. The
 * sources and their projects are in the list; the open project's tasks beside it.
 */
export default function Projects() {
  const sources = useActionResult<{ sources: Source[] }>("sources", {});
  const projects = useActionResult<{
    projects: Project[];
    errors: { source: string; error: string }[];
  }>("projects", {});
  const [opened, setOpened] = useState<string>();
  const [shown, setShown] = useState(false);
  const tasks = useActionResult<{ tasks: Task[] }>(
    "tasks",
    opened ? { project_id: opened } : { project_id: "" },
  );
  // Read again when Projects says so, and at once after a change made here.
  const reload = () => {
    void sources.reload();
    void projects.reload();
    if (opened) void tasks.reload();
  };
  useEvent("changed", reload);
  const [creating, setCreating] = useState<string>();
  const [asking, setAsking] = useState<SourceAsk>();
  const all = projects.data?.projects ?? [];
  const known = sources.data?.sources ?? [];
  const project = all.find((p) => p.id === opened);
  const source = known.find((s) => s.id === project?.source);
  const failed = (id: string) =>
    projects.data?.errors.find((error) => error.source === id)?.error;

  const list = (
    <Stack gap={12}>
      {sources.error || projects.error ? (
        <Text tone="danger">{sources.error || projects.error}</Text>
      ) : null}
      {!sources.data ? (
        <Spinner />
      ) : (
        known.map((each) => {
          const mine = all.filter((p) => p.source === each.id);
          const problem = sourceState(each) || failed(each.id);
          return (
            <Stack key={each.id} gap={6}>
              <Stack direction="row" gap={6} align="center">
                <Text size="sm" tone="muted">
                  {each.name}
                </Text>
                {can(each, "create_project") ? (
                  <IconButton
                    icon="plus"
                    label={`New project in ${each.name}`}
                    onPress={() => setCreating(each.id)}
                  />
                ) : null}
                <Menu
                  label={`${each.name} actions`}
                  items={[
                    {
                      title: "Settings",
                      icon: "settings",
                      onPress: () =>
                        setAsking({ kind: "change", source: each }),
                    },
                    ...(each.own
                      ? []
                      : [
                          {
                            title: "Remove",
                            icon: "trash-2",
                            tone: "danger" as const,
                            onPress: () =>
                              setAsking({ kind: "remove", source: each }),
                          },
                        ]),
                  ]}
                />
              </Stack>
              {problem ? <Text tone="danger">{problem}</Text> : null}
              {mine.length ? (
                <List>
                  {mine.map((p) => (
                    <ListItem
                      key={p.id}
                      title={p.name}
                      subtitle={
                        [p.key, p.archived && "Archived"]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      }
                      leading={<Icon name="kanban" />}
                      selected={p.id === opened}
                      onPress={() => {
                        setOpened(p.id);
                        setShown(true);
                      }}
                    />
                  ))}
                </List>
              ) : problem ? null : (
                <Empty>No projects</Empty>
              )}
            </Stack>
          );
        })
      )}
      <Button
        title="Add source"
        variant="secondary"
        onPress={() => setAsking({ kind: "add" })}
      />
    </Stack>
  );

  const work = tasks.data?.tasks ?? [];
  const detail = project ? (
    <Stack gap={8}>
      {tasks.error ? <Text tone="danger">{tasks.error}</Text> : null}
      {tasks.loading && !tasks.data ? (
        <Spinner />
      ) : (
        <ProjectView
          project={project}
          source={source}
          tasks={work}
          known={labelsOf(work)}
          projects={all}
          onChanged={reload}
        />
      )}
    </Stack>
  ) : (
    <Empty>No project open</Empty>
  );

  return (
    <>
      <Split
        label="Projects"
        list={list}
        detail={detail}
        open={shown && Boolean(project)}
        onBack={() => setShown(false)}
      />
      <Sheet
        open={creating !== undefined}
        onClose={() => setCreating(undefined)}
        title="New project"
      >
        {creating !== undefined ? (
          <ProjectForm
            source={creating}
            onDone={() => {
              setCreating(undefined);
              reload();
            }}
          />
        ) : null}
      </Sheet>
      <SourceSheet
        ask={asking}
        close={() => setAsking(undefined)}
        done={reload}
      />
    </>
  );
}
