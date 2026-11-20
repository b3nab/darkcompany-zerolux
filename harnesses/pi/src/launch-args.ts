// The native options a terminal started pi with that say how it is set up, to start it with
// again: never what selected its session, its first work, or a key given on the command line.
const values = new Set([
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--system-prompt",
  "--append-system-prompt",
  "--session-dir",
]);
const flags = new Set([
  "--no-builtin-tools",
  "-nbt",
  "--no-tools",
  "-nt",
  "--no-extensions",
  "-ne",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);
/** Options with a value that are not kept: what chose the session, its model, its first work. */
const dropped = new Set([
  "--session",
  "--session-id",
  "--fork",
  "--model",
  "--provider",
  "--thinking",
  "--mode",
  "--name",
  "-n",
  "--tui-mode",
  "--api-key",
]);

export function piResumeArgs(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break; // What follows is its first work.
    if (flags.has(arg)) result.push(arg);
    else if (values.has(arg) && argv[i + 1] !== undefined)
      result.push(arg, argv[++i]!);
    else if (dropped.has(arg)) i++;
  }
  return result;
}
