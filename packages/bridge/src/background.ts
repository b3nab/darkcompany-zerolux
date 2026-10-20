/** Commands a session runs in the background: it goes on, and is told how each ends. */
type Call = <T>(path: string, body?: unknown) => Promise<T>;

export interface BackgroundCommand {
  id: string;
  session_id: string;
  command: string;
  folder: string;
  status: "running" | "exited" | "stopped" | "lost";
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  told_at: number | null;
  error: string | null;
}

/** What a tool returns of a background command's output at most, from where it reads. */
const READ = 16 * 1024;

export async function runInBackground(
  call: Call,
  session: string,
  command: string,
) {
  const { background_command } = await call<{
    background_command: BackgroundCommand;
  }>(`/sessions/${encodeURIComponent(session)}/background-commands`, {
    command,
  });
  return background_command;
}

export async function listBackground(call: Call, session: string) {
  const { background_commands } = await call<{
    background_commands: BackgroundCommand[];
  }>(`/sessions/${encodeURIComponent(session)}/background-commands`);
  return background_commands;
}

/** A background command and its output from `after`; without it, the end of its output. */
export async function readBackground(call: Call, id: string, after?: number) {
  const path = `/background-commands/${encodeURIComponent(id)}`;
  let read = await call<{
    background_command: BackgroundCommand;
    output: { start: number; text: string; next: number; end: number };
  }>(`${path}?after=${after ?? 0}`);
  if (after === undefined && read.output.end > READ)
    read = await call(`${path}?after=${read.output.end - READ}`);
  const text =
    read.output.text.length > READ
      ? read.output.text.slice(0, READ)
      : read.output.text;
  return {
    status: read.background_command.status,
    exit_code: read.background_command.exit_code,
    command: read.background_command.command,
    output: text,
    from: read.output.start,
    next: read.output.start + Buffer.byteLength(text),
    end: read.output.end,
  };
}

export async function stopBackground(call: Call, id: string) {
  const { background_command } = await call<{
    background_command: BackgroundCommand;
  }>(`/background-commands/${encodeURIComponent(id)}/stop`, {});
  return background_command;
}
