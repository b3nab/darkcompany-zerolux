import { useEffect, useState } from "react";
import { errorMessage, terminalCommand } from "@zerolux/chat";
import type {
  ChatSession,
  Host,
  Perform,
  TerminalCommand,
} from "@zerolux/chat";
import { Copy } from "@/components/tool-call";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The command that continues the session in one's own terminal, on the computer it runs on.
 * A session running in ZeroLux is stopped first, so two processes never share it.
 */
export function ContinueInTerminal({
  session,
  hosts,
  open,
  close,
  stop,
  busy,
  perform,
}: {
  session: ChatSession;
  hosts: Host[] | undefined;
  open: boolean;
  close: () => void;
  /** Stops the session in ZeroLux. */
  stop: () => Promise<void>;
  busy: boolean;
  perform: Perform;
}) {
  const [read, setRead] = useState<{
    command?: TerminalCommand;
    error?: string;
  }>({});
  const load = () =>
    terminalCommand(session.id).then(
      (command) => setRead({ command }),
      (failed: unknown) => setRead({ error: errorMessage(failed) }),
    );
  useEffect(() => {
    if (open) void load();
    // It is read again each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.id]);
  const command = read.command;
  const computer = hosts?.find((host) => host.id === command?.host_id)?.name;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Continue in terminal</DialogTitle>
          <DialogDescription>
            Run this in a terminal
            {computer ? ` on ${computer}` : " on the computer it runs on"}.
          </DialogDescription>
        </DialogHeader>
        {read.error && (
          <p role="alert" className="text-sm text-destructive">
            {read.error}
          </p>
        )}
        {command && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[12px] whitespace-nowrap">
                {command.command}
              </code>
              {!command.stop_first && (
                <Copy text={command.command} className="opacity-100" />
              )}
            </div>
            {command.stop_first && (
              <Button
                className="self-start"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await stop();
                    await navigator.clipboard?.writeText(command.command);
                  }).then(() => void load())
                }
              >
                Stop and copy
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
