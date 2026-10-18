import type { Actor } from "./api";
import { cn } from "cn";
import {
  MessageCircleQuestionMarkIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from "lucide-react";
import { answerSummary, approvalLabels } from "@zerolux/chat";
import type { Approval, Conversation } from "@zerolux/chat";
import type { Chat, Perform } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { ActorMark, Eyebrow } from "@/components/presence";
import { McpForm, QuestionForm } from "./RequestAnswer";

const open = new Set<Approval["status"]>(["pending", "decided", "uncertain"]);
/** The requests still waiting for a decision or for the agent to receive it. */
export const openApprovals = (approvals: Approval[]) =>
  approvals.filter((a) => open.has(a.status));

/** Permission requests from agents: they stay here until the agent receives the decision. */
export function Approvals({
  chat,
  actors,
  busy,
  perform,
  show,
}: {
  chat: Chat;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
  show: (conversation: Conversation) => void;
}) {
  const current = openApprovals(chat.approvals);
  if (current.length === 0) return null;
  return (
    <section aria-label="Permission requests" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Eyebrow className="text-attention">Permission requests</Eyebrow>
        <span className="font-mono text-xs text-attention">
          {current.length}
        </span>
      </div>
      {current.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          chat={chat}
          actors={actors}
          busy={busy}
          perform={perform}
          show={show}
        />
      ))}
    </section>
  );
}

/** One request: who asks, for what, in which chat; only the owner answers it. */
export function ApprovalCard({
  approval,
  chat,
  actors,
  busy,
  perform,
  show,
}: {
  approval: Approval;
  chat: Chat;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
  show?: (conversation: Conversation) => void;
}) {
  const agent =
    actors.find((a) => a.id === approval.actor_id)?.name ?? "An agent";
  const conversation = chat.conversations.find(
    (c) => c.id === approval.conversation_id,
  );
  return (
    <article className="flex flex-col gap-3 rounded-md border border-human/40 bg-human/5 p-4">
      <div className="flex items-center gap-2.5">
        <ActorMark kind="agent" name={agent} className="size-6 text-[10px]" />
        <h3 className="min-w-0 flex-1 text-sm font-semibold">
          {agent} asks: {approval.summary}
        </h3>
        <time
          dateTime={new Date(approval.created_at).toISOString()}
          className="font-mono text-[11px] text-faint"
        >
          {new Date(approval.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {conversation && show && (
        <Button
          variant="link"
          className="h-auto self-start p-0"
          onClick={() => show(conversation)}
        >
          While answering in «{conversation.title}»
        </Button>
      )}
      {approval.kind === "permission" && (
        <pre className="overflow-x-auto rounded-sm border bg-background p-3 font-mono text-xs">
          {JSON.stringify(approval.details, null, 2)}
        </pre>
      )}
      {approval.kind !== "permission" ? (
        approval.status === "pending" ? (
          approval.kind === "question" ? (
            <QuestionForm
              approval={approval}
              chat={chat}
              busy={busy}
              perform={perform}
            />
          ) : (
            <McpForm
              approval={approval}
              chat={chat}
              busy={busy}
              perform={perform}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {answerSummary(approval)} · {approvalLabels[approval.status]}
          </p>
        )
      ) : approval.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void perform(() => chat.decide(approval.id, "allow"))
            }
          >
            Allow
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void perform(() => chat.decide(approval.id, "deny"))}
          >
            Deny
          </Button>
          <span className="text-xs text-faint">
            Only you can answer. The chat sees the decision.
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {approval.decision === "allow" ? "Allowed" : "Denied"} ·{" "}
          {approvalLabels[approval.status]}
        </p>
      )}
    </article>
  );
}

/** An answered request as it stays in the session's work: what was asked and what you said. */
export function ApprovalReceipt({ approval }: { approval: Approval }) {
  const permission = approval.kind === "permission";
  const answer = permission
    ? approval.decision &&
      (approval.decision === "allow" ? "Allowed" : "Denied")
    : answerSummary(approval);
  const Icon = !permission
    ? MessageCircleQuestionMarkIcon
    : approval.decision === "deny"
      ? ShieldXIcon
      : ShieldCheckIcon;
  return (
    <p className="flex min-w-0 items-center gap-2 rounded-md border border-human/20 bg-human/5 px-3 py-1.5 text-[13px]">
      <Icon aria-hidden className="size-3.5 shrink-0 text-human" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {approval.summary}
      </span>
      {answer && (
        <span className="max-w-[40%] shrink-0 truncate font-medium">
          {answer}
        </span>
      )}
      <span
        className={cn(
          "shrink-0 font-mono text-[11px] text-faint",
          approval.status === "uncertain" && "text-attention",
        )}
      >
        {approvalLabels[approval.status]}
      </span>
    </p>
  );
}
