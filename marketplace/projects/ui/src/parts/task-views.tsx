import type { ReactNode } from "react";
import { Avatar, Badge, Card, Icon, ListItem, Stack, Text } from "@zerolux/ui";
import { dueLabel, dueTone, priorityOf, statusOf } from "./model";
import type { Status, Task } from "./model";

/** What a task carries besides its title, in a line: its key, its due day, its labels. */
const details = (task: Task) =>
  [task.key, task.due ? dueLabel(task.due) : "", ...task.labels]
    .filter(Boolean)
    .join(" · ");

/** A state's name with its icon and how many tasks are in it, then what it offers. */
export function StatusHeading({
  status,
  count,
  children,
}: {
  status: Status;
  count: number;
  children?: ReactNode;
}) {
  const { label, icon } = statusOf(status);
  return (
    <Stack direction="row" gap={8}>
      <Icon name={icon} size={16} />
      <Text size="sm">{label}</Text>
      <Text size="sm" tone="muted">
        {String(count)}
      </Text>
      {children}
    </Stack>
  );
}

/** A task on the board: its key and priority, its title, then its due day, labels and assignee. */
export function TaskCard({
  task,
  onPress,
}: {
  task: Task;
  onPress: () => void;
}) {
  const priority = priorityOf(task.priority);
  return (
    <Card onPress={onPress}>
      <Stack gap={6}>
        <Stack direction="row" gap={6}>
          {task.priority === "none" ? null : (
            <Icon
              name={priority.icon}
              size={14}
              tone={task.priority === "urgent" ? "danger" : "muted"}
            />
          )}
          <Text size="sm" mono tone="muted">
            {task.key}
          </Text>
        </Stack>
        <Text>{task.title}</Text>
        {task.due || task.labels.length || task.assignee ? (
          <Stack direction="row" gap={6}>
            {task.due ? (
              <Badge tone={dueTone(task)}>{dueLabel(task.due)}</Badge>
            ) : null}
            {task.labels.map((label) => (
              <Badge key={label}>{label}</Badge>
            ))}
            {task.assignee ? (
              <Avatar actorId={task.assignee} size="sm" />
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

/** A task in a list: its priority before the title, its details below, its assignee after. */
export function TaskRow({
  task,
  onPress,
}: {
  task: Task;
  onPress: () => void;
}) {
  const priority = priorityOf(task.priority);
  return (
    <ListItem
      title={task.title}
      subtitle={details(task)}
      leading={
        <Icon
          name={priority.icon}
          size={16}
          tone={task.priority === "urgent" ? "danger" : "muted"}
        />
      }
      accessory={
        task.assignee ? <Avatar actorId={task.assignee} size="sm" /> : undefined
      }
      onPress={onPress}
    />
  );
}
