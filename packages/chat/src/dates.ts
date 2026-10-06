export interface CreationDate {
  created_at: number;
}

const DAY = 24 * 60 * 60 * 1000;
const valid = (timestamp: number) =>
  Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8.64e15;

/** UTC dates keep the same calendar label on every device. */
export function creationDateLabel(record: CreationDate): string {
  if (!valid(record.created_at)) return "Creation date unavailable";
  return `Created ${new Date(record.created_at).toISOString().slice(0, 10)}`;
}

/** Day 1 starts at creation. */
export function workspaceAge(record: CreationDate, now = Date.now()): string {
  if (!valid(record.created_at) || !valid(now) || record.created_at > now)
    return creationDateLabel(record);
  return `Day ${Math.floor((now - record.created_at) / DAY) + 1}`;
}
