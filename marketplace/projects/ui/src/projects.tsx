import { useState } from "react";
import {
  Button,
  Columns,
  Empty,
  Icon,
  IconButton,
  Input,
  List,
  ListItem,
  Menu,
  Page,
  Section,
  Sheet,
  Spinner,
  Split,
  Stack,
  Tabs,
  Text,
  useAction,
  useActionResult,
  useEvent,
  useOpen,
} from "@zerolux/ui";
import type { MenuEntry } from "@zerolux/ui";
import {
  byStatus,
  can,
  keyFrom,
  labelsOf,
  matches,
  sourceState,
  tap,
} from "./parts/model";
import type { Project, Source, Task } from "./parts/model";
import { SourceSheet, type SourceAsk } from "./parts/sources";
import { NewTask } from "./parts/new-task";
import type { Start } from "./parts/new-task";
import { TaskDetail } from "./parts/task-sheet";
import { useTaskMenu } from "./parts/task-menu";
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

/**
 * The workspace's projects as a screen of the app: the sources with their projects at the
 * side; the open project on top with its views, search and New task; its tasks on a board or
 * in a list by state, each changed from its menu without opening it, or open in the inspector
 * beside them. Cards dragged onto another card take its state.
 */
export default function Projects() {
  const sources = useActionResult<{ sources: Source[] }>("sources", {});
  const projects = useActionResult<{
    projects: Project[];
    errors: { source: string; error: string }[];
  }>("projects", {});
  const [opened, setOpened] = useState<string>();
  const [shown, setShown] = useState(false);
  const all = projects.data?.projects ?? [];
  // The project chosen, or the first still open.
  const project =
    all.find((p) => p.id === opened) ?? all.find((p) => !p.archived) ?? all[0];
  const tasks = useActionResult<{ tasks: Task[] }>(
    "tasks",
    project ? { project_id: project.id } : { project_id: "" },
  );
  // Read again when Projects says so, and at once after a change made here.
  const reload = () => {
    void sources.reload();
    void projects.reload();
    if (project) void tasks.reload();
  };
  useEvent("changed", reload);
  const [creating, setCreating] = useState<string>();
  const [editing, setEditing] = useState<Project>();
  const [asking, setAsking] = useState<SourceAsk>();
  const [layout, setLayout] = useState("list");
  const [query, setQuery] = useState("");
  // Done and dropped tasks stay folded in the list until asked for.
  const [unfolded, setUnfolded] = useState(false);
  const [inspected, setInspected] = useState<string>();
  const [start, setStart] = useState<Start>();
  const [deleting, setDeleting] = useState<Task>();
  const update = useAction("update_project");
  const remove = useAction("delete_task");
  const browse = useOpen();
  const known = sources.data?.sources ?? [];
  const source = known.find((s) => s.id === project?.source);
  const failed = (id: string) =>
    projects.data?.errors.find((error) => error.source === id)?.error;
  const work = tasks.data?.tasks ?? [];
  const found = work.filter((task) => matches(task, query));
  const inspect = (task: Task) => setInspected(task.id);
  const taskMenu = useTaskMenu({
    sources: known,
    onChanged: reload,
    onOpen: inspect,
    onDelete: setDeleting,
  });
  const openProject = (p: Project) => {
    setOpened(p.id);
    setShown(true);
    setInspected(undefined);
    setQuery("");
  };

  const projectMenu = (p: Project): MenuEntry[] => {
    const from = known.find((s) => s.id === p.source);
    return [
      {
        title: "Open",
        icon: "panel-right-open",
        onPress: () => openProject(p),
      },
      ...(can(from, "edit_project")
        ? [
            {
              title: "Edit project",
              icon: "pencil",
              onPress: () => setEditing(p),
            },
            {
              title: p.archived ? "Restore project" : "Archive project",
              icon: p.archived ? "archive-restore" : "archive",
              onPress: () =>
                tap(
                  update.run({ id: p.id, archived: !p.archived }).then(reload),
                ),
            },
          ]
        : []),
      ...(p.url
        ? [
            { divider: true as const },
            {
              title: `Open in ${from?.name ?? "the tracker"}`,
              icon: "external-link",
              onPress: () => void browse(p.url!),
            },
          ]
        : []),
    ];
  };

  const sourceMenu = (each: Source): MenuEntry[] => [
    ...(can(each, "create_project")
      ? [
          {
            title: "New project",
            icon: "plus",
            onPress: () => setCreating(each.id),
          },
        ]
      : []),
    {
      title: "Settings",
      icon: "settings",
      onPress: () => setAsking({ kind: "change", source: each }),
    },
    ...(each.own
      ? []
      : [
          { divider: true as const },
          {
            title: "Remove",
            icon: "trash-2",
            tone: "danger" as const,
            onPress: () => setAsking({ kind: "remove", source: each }),
          },
        ]),
  ];

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
            <Section
              key={each.id}
              title={each.name}
              actions={
                <Menu label={`${each.name} actions`} items={sourceMenu(each)} />
              }
            >
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
                      leading={<Icon name="square-kanban" tone="muted" />}
                      selected={p.id === project?.id}
                      onPress={() => openProject(p)}
                      menu={projectMenu(p)}
                    />
                  ))}
                </List>
              ) : problem ? null : (
                <Empty>No projects</Empty>
              )}
            </Section>
          );
        })
      )}
    </Stack>
  );

  const add = (status?: Task["status"]) =>
    project && setStart({ project: project.id, status });
  const groups = byStatus(found);
  // The board leaves out what was dropped, unless something was.
  const columns = groups.filter(
    (group) => group.value !== "cancelled" || group.tasks.length,
  );
  // A card dropped on another takes its state.
  const dropOn = (task: Task) => (ids: string[]) => {
    for (const id of ids) {
      const moved = work.find((each) => each.id === id);
      if (moved && moved.status !== task.status)
        taskMenu.change(moved, { status: task.status });
    }
  };
  const place = (task: Task) => ({
    menu: taskMenu.menu(task),
    selected: task.id === inspected,
    drag: task.id,
    onDrop: dropOn(task),
  });
  const shownTask = work.find((task) => task.id === inspected);

  const board = (
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
            <TaskCard
              key={task.id}
              task={task}
              onPress={() => inspect(task)}
              {...place(task)}
            />
          ))}
        </Stack>
      ))}
    </Columns>
  );

  const rows = found.length ? (
    <Stack gap={16}>
      {groups
        .filter((group) => group.tasks.length)
        .map((group) => {
          const finished =
            group.value === "done" || group.value === "cancelled";
          return (
            <Section
              key={group.value}
              title={`${group.label} · ${group.tasks.length}`}
              actions={
                finished ? (
                  <Button
                    title={unfolded ? "Hide" : "Show"}
                    variant="ghost"
                    onPress={() => setUnfolded(!unfolded)}
                  />
                ) : (
                  <IconButton
                    icon="plus"
                    label={`New task in ${group.label}`}
                    onPress={() => add(group.value)}
                  />
                )
              }
            >
              {finished && !unfolded && !query ? null : (
                <List>
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onPress={() => inspect(task)}
                      {...place(task)}
                    />
                  ))}
                </List>
              )}
            </Section>
          );
        })}
    </Stack>
  ) : (
    <Empty>{query ? "No tasks match" : "No tasks"}</Empty>
  );

  const detail = project ? (
    <Page
      title={project.name}
      subtitle={
        [project.key, source?.name, project.archived && "Archived"]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      search={{
        placeholder: `Search ${project.name}`,
        value: query,
        onChange: setQuery,
      }}
      actions={
        <>
          <Tabs
            items={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
            ]}
            value={layout}
            onChange={setLayout}
          />
          <Menu label="Project" items={projectMenu(project).slice(1)} />
          <Button title="New task" variant="primary" onPress={() => add()} />
        </>
      }
      inspector={
        shownTask
          ? {
              title: shownTask.key,
              onClose: () => setInspected(undefined),
              content: (
                <TaskDetail
                  key={shownTask.id}
                  id={shownTask.id}
                  known={labelsOf(work)}
                  onChanged={reload}
                  onGone={() => setInspected(undefined)}
                />
              ),
            }
          : undefined
      }
      menu={[
        {
          title: "New task",
          icon: "plus",
          onPress: () => add(),
        },
        { divider: true },
        { section: "View" },
        {
          title: "List",
          checked: layout === "list",
          onPress: () => setLayout("list"),
        },
        {
          title: "Board",
          checked: layout === "board",
          onPress: () => setLayout("board"),
        },
      ]}
    >
      <Stack gap={8}>
        {tasks.error || update.error || taskMenu.error ? (
          <Text tone="danger">
            {tasks.error || update.error || taskMenu.error}
          </Text>
        ) : null}
        {tasks.loading && !tasks.data ? (
          <Spinner />
        ) : layout === "board" ? (
          board
        ) : (
          rows
        )}
      </Stack>
    </Page>
  ) : (
    <Empty>No project open</Empty>
  );

  return (
    <>
      <Split
        label="Projects"
        actions={
          <IconButton
            icon="plus"
            label="Add source"
            onPress={() => setAsking({ kind: "add" })}
          />
        }
        list={list}
        detail={detail}
        open={shown && Boolean(project)}
        onBack={() => setShown(false)}
      />
      <NewTask
        start={start}
        projects={all}
        onCreated={reload}
        onClose={() => setStart(undefined)}
      />
      <Sheet
        open={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title={deleting ? `Delete ${deleting.key}?` : undefined}
      >
        {deleting ? (
          <Stack gap={12}>
            <Text>{deleting.title}</Text>
            {remove.error ? <Text tone="danger">{remove.error}</Text> : null}
            <Stack direction="row" gap={8}>
              <Button
                title="Delete"
                variant="danger"
                busy={remove.busy}
                onPress={() =>
                  tap(
                    remove.run({ id: deleting.id }).then(() => {
                      if (inspected === deleting.id) setInspected(undefined);
                      setDeleting(undefined);
                      reload();
                    }),
                  )
                }
              />
              <Button
                title="Cancel"
                variant="ghost"
                onPress={() => setDeleting(undefined)}
              />
            </Stack>
          </Stack>
        ) : null}
      </Sheet>
      <Sheet
        open={creating !== undefined || editing !== undefined}
        onClose={() => (setCreating(undefined), setEditing(undefined))}
        title={editing ? "Edit project" : "New project"}
      >
        {creating !== undefined || editing ? (
          <ProjectForm
            key={editing?.id ?? creating}
            project={editing}
            source={creating}
            onDone={() => {
              setCreating(undefined);
              setEditing(undefined);
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
