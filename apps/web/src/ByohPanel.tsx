import {
  activeActors,
  harnessLabels,
  liveConnection,
  workerCommand,
} from "./api";
import type { Actor, Project, Workspace } from "./api";
import { Button } from "@/components/ui/button";
import { Eyebrow, Presence } from "@/components/presence";

const code = "rounded bg-muted px-1 py-0.5 font-mono text-xs";
const block =
  "overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre";

/** Running tasks still happens from a terminal; chats do not need one. */
export function ByohPanel({
  workspace,
  project,
  agent,
  hire,
  selectAgent,
}: {
  workspace: Workspace;
  project?: Project;
  agent?: Actor;
  hire: () => void;
  selectAgent?: (id: string) => void;
}) {
  const actors = activeActors(workspace.actors);
  return (
    <section
      aria-label="Run tasks with your agents"
      className="mb-6 flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-4">
        <Eyebrow>BYOH / task workers</Eyebrow>
        <Eyebrow>No auto-start</Eyebrow>
      </div>
      <h3 className="text-lg font-semibold">
        Run tasks with the agents you hired.
      </h3>
      <p className="text-sm text-muted-foreground">
        Task execution does not start by itself: connect a worker from a
        terminal as shown below. To verify installed CLIs locally:{" "}
        <code className={code}>cargo run -- doctor</code>.
      </p>
      {!actors.some((a) => a.kind === "agent") && (
        <div className="flex flex-col items-start gap-3 rounded-lg bg-muted/50 p-3">
          <p className="text-sm">
            No agents yet. Nothing starts automatically.
          </p>
          <Button onClick={hire}>Hire an agent</Button>
        </div>
      )}
      <ul className="divide-y rounded-lg border">
        {actors
          .filter((a) => a.harness)
          .map((actor) => {
            const connection = liveConnection(
              workspace.connections ?? [],
              actor.id,
            );
            return (
              <li
                key={actor.id}
                className="flex flex-wrap items-start justify-between gap-3 p-3"
              >
                <div className="flex flex-col items-start gap-1">
                  <strong className="text-sm font-medium">{actor.name}</strong>
                  <span className="text-xs text-muted-foreground">
                    {actor.harness && harnessLabels[actor.harness]} · owned by{" "}
                    {
                      workspace.actors.find((a) => a.id === actor.owner_id)
                        ?.name
                    }
                  </span>
                  {selectAgent && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={actor.id === agent?.id}
                      onClick={() => selectAgent(actor.id)}
                    >
                      {actor.id === agent?.id ? "Selected" : "Select agent"}
                    </Button>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <Presence tone={connection ? "connected" : "stopped"}>
                    {connection
                      ? connection.mode === "pi_session"
                        ? "pi session attached"
                        : "Process worker connected"
                      : "Not connected"}
                  </Presence>
                  {connection && (
                    <>
                      <small className="text-xs text-muted-foreground">
                        Project:{" "}
                        {
                          workspace.projects.find(
                            (p) => p.id === connection.project_id,
                          )?.name
                        }
                      </small>
                      <code className={code}>{connection.workspace}</code>
                    </>
                  )}
                </div>
              </li>
            );
          })}
      </ul>
      {project && agent && (
        <details open className="flex flex-col gap-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Connect {agent.name} to {project.name}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {agent.harness === "pi" && (
              <>
                <h4 className="font-semibold">This existing pi conversation</h4>
                <p className="text-muted-foreground">
                  Review the project extension, grant project trust if needed,
                  then run <code className={code}>/reload</code> in pi. No
                  connection is made until you confirm:
                </p>
                <pre className={block}>
                  /zerolux connect {project.id} {agent.id}
                </pre>
                <p className="text-muted-foreground">
                  Then use <code className={code}>/zerolux take</code> to
                  explicitly claim one queued task in this session's current
                  workspace. Its final response goes to human review.{" "}
                  <code className={code}>/zerolux disconnect</code> detaches
                  without closing the conversation.
                </p>
              </>
            )}
            <h4 className="font-semibold">
              {agent.harness === "pi"
                ? "Alternatively: a fresh pi process"
                : "A fresh local process"}
            </h4>
            <pre className={block}>{workerCommand(project.id, agent)}</pre>
            <p className="text-muted-foreground">
              No session resume or permission bypass is enabled. Use different
              worktrees for concurrent agents. A workspace connection is not a
              sandbox.
            </p>
          </div>
        </details>
      )}
    </section>
  );
}
