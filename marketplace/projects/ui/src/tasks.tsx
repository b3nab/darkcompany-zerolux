import { useState } from "react";
import {
  Button,
  Empty,
  List,
  Spinner,
  Stack,
  Text,
  useActionResult,
  useActors,
  useEvent,
  useSpace,
} from "@zerolux/ui";
import { byUrgency, labelsOf } from "./parts/model";
import type { Project, Status, Task } from "./parts/model";
import { NewTask } from "./parts/new-task";
import type { Start } from "./parts/new-task";
import { TaskSheet } from "./parts/task-sheet";
import { StatusHeading, TaskRow } from "./parts/task-views";

/** How many done tasks show when unfolded, the latest first. */
const DONE = 5;

/** What the agent is on first, then what waits. */
const ACTIVE: Status[] = ["in_progress", "in_review", "todo", "backlog"];

/**
 * Beside a session, the tasks of its agent: what is still to do by state, the latest done,
 * and a new task given to it.
 */
export default function SessionTasks() {
  const { context } = useSpace();
  const agent = context.actor_id;
  const name = useActors().find((actor) => actor.id === agent)?.name;
  // A session without an agent asks for nobody's tasks.
  const tasks = useActionResult<{ tasks: Task[] }>("tasks", {
    assignee: agent ?? "",
  });
  const projects = useActionResult<{ projects: Project[] }>("projects");
  // Read again when Projects says so, and at once after a change made here.
  const reload = () => {
    void tasks.reload();
    void projects.reload();
  };
  useEvent("changed", reload);
  const [shown, setShown] = useState<string>();
  const [start, setStart] = useState<Start>();
  const [unfolded, setUnfolded] = useState(false);
  if (!agent) return <Empty>No agent</Empty>;
  const all = tasks.data?.tasks ?? [];
  const live = projects.data?.projects.filter((p) => !p.archived) ?? [];
  const groups = ACTIVE.map((value) => ({
    value,
    tasks: all.filter((task) => task.status === value).sort(byUrgency),
  })).filter((group) => group.tasks.length);
  const done = all
    .filter((task) => task.status === "done")
    .sort((a, b) => b.updated_at - a.updated_at);
  const error = tasks.error || projects.error;
  return (
    <Stack gap={16}>
      <Button
        title={name ? `New task for ${name}` : "New task"}
        variant="secondary"
        disabled={!live.length}
        onPress={() => setStart({ assignee: agent })}
      />
      {error ? <Text tone="danger">{error}</Text> : null}
      {!tasks.data ? (
        error ? null : (
          <Spinner />
        )
      ) : groups.length || done.length ? (
        <>
          {groups.map((group) => (
            <Stack key={group.value} gap={8}>
              <StatusHeading status={group.value} count={group.tasks.length} />
              <List>
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onPress={() => setShown(task.id)}
                  />
                ))}
              </List>
            </Stack>
          ))}
          {done.length ? (
            <Stack gap={8}>
              <StatusHeading status="done" count={done.length}>
                <Button
                  title={unfolded ? "Hide" : "Show"}
                  variant="ghost"
                  onPress={() => setUnfolded(!unfolded)}
                />
              </StatusHeading>
              {unfolded ? (
                <List>
                  {done.slice(0, DONE).map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onPress={() => setShown(task.id)}
                    />
                  ))}
                </List>
              ) : null}
            </Stack>
          ) : null}
        </>
      ) : (
        <Empty>No tasks</Empty>
      )}
      <TaskSheet
        task={all.find((task) => task.id === shown)}
        known={labelsOf(all)}
        onChanged={reload}
        onClose={() => setShown(undefined)}
      />
      <NewTask
        start={start}
        projects={live}
        onCreated={reload}
        onClose={() => setStart(undefined)}
      />
    </Stack>
  );
}
