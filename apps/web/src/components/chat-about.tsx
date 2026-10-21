import { cn } from "cn";
import { harnessLabels, sessionState, useUiPieces } from "@zerolux/chat";
import type { Actor, ChatSession, Conversation } from "@zerolux/chat";
import { ExtensionView } from "../extension-view";
import { sessionTone } from "../presence";
import { Lamp } from "./lamp";
import { ActorMark, Eyebrow } from "./presence";

/** Beside a chat: who is in it, what each is doing, and what its extensions show there. */
export function ChatAbout({
  conversation,
  actors,
  sessions,
  className,
}: {
  conversation: Conversation;
  actors: Actor[];
  sessions: ChatSession[];
  className?: string;
}) {
  const sections = useUiPieces("chat");
  return (
    <aside
      aria-label="About this chat"
      className={cn(
        "flex min-h-0 flex-col gap-7 overflow-y-auto border-l bg-sidebar px-4.5 py-5.5",
        className,
      )}
    >
      <section className="flex flex-col gap-1.5">
        <Eyebrow>Members · {conversation.members.length}</Eyebrow>
        <ul>
          {conversation.members.map((member) => {
            const actor = actors.find((a) => a.id === member.actor_id);
            const session = sessions.find((s) => s.id === member.session_id);
            const agent = actor?.kind !== "human";
            return (
              <li
                key={member.actor_id}
                className="flex items-center gap-2.5 py-1.5"
              >
                <span className="relative shrink-0">
                  <ActorMark
                    kind={agent ? "agent" : "human"}
                    name={actor?.name ?? "?"}
                    className="size-7"
                  />
                  {session && (
                    <Lamp
                      kind="agent"
                      state={sessionTone(session)}
                      className="absolute -right-0.5 -bottom-0.5 size-1.5 outline-2 outline-sidebar"
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "truncate text-sm font-semibold",
                      agent && "font-mono font-medium text-agent-foreground",
                    )}
                  >
                    {actor?.name ?? "Unknown"}
                  </span>
                  <span className="truncate font-mono text-[11px] text-faint">
                    {!agent
                      ? "Person"
                      : actor?.harness
                        ? harnessLabels[actor.harness]
                        : "Agent"}
                  </span>
                </span>
                {session && (
                  <span
                    className={cn(
                      "shrink-0 text-[11px]",
                      session.status === "attention"
                        ? "text-attention"
                        : "text-faint",
                    )}
                  >
                    {sessionState(session)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {sections.map((piece) => (
        <section
          key={`${piece.extension}/${piece.name}`}
          aria-label={piece.title}
          className="flex flex-col gap-1.5"
        >
          <Eyebrow>{piece.title}</Eyebrow>
          <ExtensionView
            piece={piece}
            context={{ conversation_id: conversation.id }}
          />
        </section>
      ))}
    </aside>
  );
}
