import { useAction, useActors, useCopy, useOpen } from "@zerolux/ui";
import type { MenuEntry } from "@zerolux/ui";
import { can, priorities, statuses, tap } from "./model";
import type { Source, Task } from "./model";

/**
 * What can be done with a task without opening it: its state, priority and assignee as
 * submenus, the tracker's page, and deleting it. The same on its "…", a right click and a long
 * press.
 */
export function useTaskMenu({
  sources,
  onChanged,
  onOpen,
  onDelete,
}: {
  sources: Source[];
  onChanged: () => void;
  onOpen: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const update = useAction("update_task");
  const actors = useActors();
  const browse = useOpen();
  const copy = useCopy();
  const change = (task: Task, fields: Partial<Task>) =>
    tap(update.run({ id: task.id, ...fields }).then(onChanged));

  const menu = (task: Task): MenuEntry[] => {
    const source = sources.find((each) => each.id === task.source);
    const tracked = source ? source.tracker !== "local" : false;
    // In a tracker, people are given tasks there: here only an agent.
    const people = tracked
      ? []
      : actors.filter((actor) => actor.kind === "human");
    const agents = actors.filter((actor) => actor.kind === "agent");
    const assign = (actor: { id: string; name: string }) => ({
      title: actor.name,
      checked: task.assignee === actor.id,
      onPress: () => change(task, { assignee: actor.id }),
    });
    return [
      {
        title: "Open",
        icon: "panel-right-open",
        onPress: () => onOpen(task),
      },
      { divider: true },
      {
        title: "Status",
        icon: "circle-dashed",
        items: statuses.map((status) => ({
          title: status.label,
          icon: status.icon,
          checked: task.status === status.value,
          onPress: () => change(task, { status: status.value }),
        })),
      },
      {
        title: "Priority",
        icon: "signal-high",
        items: priorities.map((priority) => ({
          title: priority.label,
          icon: priority.icon,
          checked: task.priority === priority.value,
          onPress: () => change(task, { priority: priority.value }),
        })),
      },
      {
        title: tracked ? "Give to an agent" : "Assign to",
        icon: "user-round",
        items: [
          ...(people.length
            ? [{ section: "People" }, ...people.map(assign)]
            : []),
          ...(agents.length
            ? [{ section: "Agents" }, ...agents.map(assign)]
            : []),
          { divider: true as const },
          {
            title: "No one",
            checked: !task.assignee,
            onPress: () => change(task, { assignee: null }),
          },
        ],
      },
      {
        title: "Due date…",
        icon: "calendar",
        onPress: () => onOpen(task),
      },
      ...(task.url
        ? [
            { divider: true as const },
            {
              title: `Open in ${source?.name ?? "the tracker"}`,
              icon: "external-link",
              onPress: () => void browse(task.url!),
            },
            {
              title: "Copy link",
              icon: "link",
              shortcut: "⌥⌘C",
              onPress: () => void copy(task.url!),
            },
          ]
        : []),
      ...(!tracked || can(source, "delete")
        ? [
            { divider: true as const },
            {
              title: "Delete",
              icon: "trash-2",
              tone: "danger" as const,
              shortcut: "⌘⌫",
              onPress: () => onDelete(task),
            },
          ]
        : []),
    ];
  };
  return { menu, error: update.error, change };
}
