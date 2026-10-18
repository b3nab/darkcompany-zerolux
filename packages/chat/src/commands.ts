/** A command typed in a session's box, which ZeroLux runs with the harness's own control. */
export interface SessionCommand {
  name: string;
  /** What it does, as the menu above the box says it. */
  description: string;
}

export const sessionCommands: SessionCommand[] = [
  {
    name: "compact",
    description: "Summarize the older work, so the session has room again",
  },
];

/**
 * The command a session's box holds and what follows it. Any other text, an unknown command
 * included, goes to the session as it is, as the harnesses themselves do.
 */
export function sessionCommand(
  text: string,
): { name: string; args: string } | undefined {
  const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command =
    typed && sessionCommands.find((c) => c.name === typed[1]!.toLowerCase());
  return command
    ? { name: command.name, args: typed[2]?.trim() ?? "" }
    : undefined;
}

/** The commands that match what is typed so far, for the menu above the box. */
export function commandsFor(text: string): SessionCommand[] {
  const typed = /^\/(\S*)$/.exec(text);
  return typed
    ? sessionCommands.filter((c) => c.name.startsWith(typed[1]!.toLowerCase()))
    : [];
}
