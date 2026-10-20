import { useEffect, useState } from "react";
import { kernelUrl, request } from "./client";

/**
 * A command offered in a session's box: ZeroLux's own, which ZeroLux runs with the harness's
 * control, or one of the harness's commands and skills, written as in its terminal.
 */
export interface SessionCommand {
  name: string;
  /** What to write to run it: `/name`, or `$name` for a Codex skill. */
  invoke: string;
  /** What it does, as the menu above the box says it. */
  description: string;
  /** What it takes after it, as its harness says. */
  hint?: string;
}

/** ZeroLux's own commands. */
export const sessionCommands: SessionCommand[] = [
  {
    name: "compact",
    invoke: "/compact",
    description: "Summarize the older work",
    hint: "what to keep",
  },
];

/**
 * ZeroLux's own command a session's box holds, and what follows it. Any other text, the
 * harness's commands and unknown ones included, goes to the session as it is, as the
 * harnesses themselves take it.
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

/**
 * The commands that match what is typed so far, for the menu above the box: ZeroLux's own,
 * then the harness's; where both have one by the same name, ZeroLux's.
 */
export function commandsFor(
  text: string,
  harness: SessionCommand[] = [],
): SessionCommand[] {
  const typed = /^[/$]\S*$/.exec(text);
  if (!typed) return [];
  const prefix = typed[0].toLowerCase();
  return [
    ...sessionCommands,
    ...harness.filter(
      (command) =>
        !sessionCommands.some((own) => own.invoke === command.invoke),
    ),
  ].filter((command) => command.invoke.toLowerCase().startsWith(prefix));
}

interface Listed {
  name: string;
  description?: string | null;
  argument_hint?: string | null;
  invoke: string;
}

/**
 * The commands and skills of a session's harness, as the kernel lists them. None while
 * they load, or when the harness lists none.
 */
export function useSessionCommands(
  sessionId: string,
  kernel = kernelUrl(),
): SessionCommand[] {
  const [listed, setListed] = useState<{
    key: string;
    commands: SessionCommand[];
  }>();
  const key = `${kernel}\n${sessionId}`;
  useEffect(() => {
    const controller = new AbortController();
    void request<{ commands: Listed[] }>(
      kernel,
      `/sessions/${encodeURIComponent(sessionId)}/commands`,
      undefined,
      controller.signal,
    ).then(
      ({ commands }) =>
        setListed({
          key,
          commands: commands.map((command) => ({
            name: command.name,
            invoke: command.invoke,
            description: command.description ?? "",
            hint: command.argument_hint ?? undefined,
          })),
        }),
      // Without them, ZeroLux's own commands stay.
      () => undefined,
    );
    return () => controller.abort();
  }, [kernel, sessionId, key]);
  return listed?.key === key ? listed.commands : [];
}
