import { cn } from "cn";
import { fileUrl, harnessLabels, sessionState } from "@zerolux/chat";
import type { Actor, ChatSession, Conversation, Storage } from "@zerolux/chat";
import { sessionTone } from "../presence";
import { FileGlyph, fileSize } from "./file";
import { Lamp } from "./lamp";
import { ActorMark, Eyebrow } from "./presence";

/** Beside a chat: who is in it and what each is doing, its tasks, and the files shared in it. */
export function ChatAbout({
  conversation,
  actors,
  sessions,
  storage,
  className,
}: {
  conversation: Conversation;
  actors: Actor[];
  sessions: ChatSession[];
  storage: Storage;
  className?: string;
}) {
  const files = storage.files
    .filter((f) => f.conversation_id === conversation.id)
    .sort((a, b) => b.updated_at - a.updated_at);
  const images = files.filter((f) => f.content_type.startsWith("image/"));
  const others = files.filter((f) => !images.includes(f));
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
      <section className="flex flex-col gap-2">
        <Eyebrow>Tasks from this chat</Eyebrow>
        {/* TODO: kernel: tasks started from a chat message, listed by chat, each with its status. */}
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      </section>
      <section className="flex flex-col gap-2">
        <Eyebrow>Files · {files.length}</Eyebrow>
        {images.length > 0 && (
          <ul className="grid grid-cols-3 gap-1.5">
            {images.map((file) => (
              <li key={file.id}>
                <a href={fileUrl(file)} target="_blank" rel="noreferrer">
                  <img
                    src={fileUrl(file)}
                    alt={file.name}
                    loading="lazy"
                    className="aspect-square w-full rounded-sm border object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
        <ul className="flex flex-col">
          {others.map((file) => (
            <li key={file.id}>
              <a
                href={fileUrl(file)}
                target="_blank"
                rel="noreferrer"
                className="-mx-2 flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                <FileGlyph file={file} className="size-4 shrink-0 text-faint" />
                <span className="truncate">{file.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                  {fileSize(file.size)}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {files.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {storage.error ||
              (storage.available
                ? "No files shared here yet."
                : "This kernel has no storage yet.")}
          </p>
        )}
      </section>
    </aside>
  );
}
