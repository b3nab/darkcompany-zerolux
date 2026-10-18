import { useState } from "react";
import { TextInput, View } from "react-native";
import {
  MessageCircleQuestionMarkIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import {
  answerSummary,
  approvalLabels,
  scopeLabels,
  scopesOf,
} from "@zerolux/chat";
import type {
  Approval,
  ApprovalScope,
  FormAnswer,
  QuestionAnswer,
} from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { McpForm, QuestionForm } from "@/components/request-answer";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type Decide = (
  decision: "allow" | "deny",
  options?: { scope?: ApprovalScope; reason?: string },
) => void;

/**
 * What an agent asks: a permission, a question or an MCP form. Only the owner answers: a
 * permission once, for the session or always, as the request offers, or no with a reason.
 */
export function ApprovalCard({
  approval,
  agent,
  busy,
  decide,
  answer,
}: {
  approval: Approval;
  agent: string;
  busy: boolean;
  decide: Decide;
  answer: (answer: QuestionAnswer | FormAnswer) => void;
}) {
  const [reason, setReason] = useState("");
  const faint = String(useCSSVariable("--color-faint"));
  const scopes = scopesOf(approval);
  return (
    <View className="gap-3 rounded-md border border-human/40 bg-human/5 p-4">
      <View className="flex-row items-center gap-2.5">
        <ActorMark kind="agent" name={agent} size="sm" />
        <Text className="flex-1 text-sm font-semibold">
          {agent} asks: {approval.summary}
        </Text>
      </View>
      {approval.kind === "permission" ? (
        <Text className="rounded-sm border border-border bg-background p-3 font-mono text-xs">
          {JSON.stringify(approval.details, null, 2)}
        </Text>
      ) : null}
      {approval.kind !== "permission" ? (
        approval.status === "pending" ? (
          approval.kind === "question" ? (
            <QuestionForm approval={approval} busy={busy} answer={answer} />
          ) : (
            <McpForm approval={approval} busy={busy} answer={answer} />
          )
        ) : (
          <Text className="text-sm text-muted-foreground">
            {answerSummary(approval)} · {approvalLabels[approval.status]}
          </Text>
        )
      ) : approval.status === "pending" ? (
        <View className="gap-2">
          <View className="flex-row flex-wrap gap-2">
            {scopes.map((scope, i) => (
              <Button
                key={scope}
                variant={i === 0 ? "default" : "outline"}
                disabled={busy}
                onPress={() => decide("allow", { scope })}
              >
                <Text>
                  {scopes.length === 1 ? "Allow" : scopeLabels[scope]}
                </Text>
              </Button>
            ))}
          </View>
          <View className="flex-row items-end gap-2">
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Why not, if you deny (optional)"
              placeholderTextColor={faint}
              maxLength={2000}
              multiline
              accessibilityLabel="Reason for denying"
              className="max-h-24 min-h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 font-sans text-sm text-foreground"
            />
            <Button
              variant="outline"
              disabled={busy}
              onPress={() =>
                decide("deny", { reason: reason.trim() || undefined })
              }
            >
              <Text>Deny</Text>
            </Button>
          </View>
          <Text className="text-xs text-faint">
            Only you can answer. The chat sees the decision.
          </Text>
        </View>
      ) : (
        <Text className="text-sm text-muted-foreground">
          {answerSummary(approval)} · {approvalLabels[approval.status]}
        </Text>
      )}
    </View>
  );
}

/** An answered request as it stays in the session's work: what was asked and what you said. */
export function ApprovalReceipt({ approval }: { approval: Approval }) {
  const human = String(useCSSVariable("--color-human"));
  const permission = approval.kind === "permission";
  const answer = answerSummary(approval);
  const Icon = !permission
    ? MessageCircleQuestionMarkIcon
    : approval.decision === "deny"
      ? ShieldXIcon
      : ShieldCheckIcon;
  return (
    <View className="flex-row items-center gap-2 rounded-md border border-human/20 bg-human/5 px-3 py-1.5">
      <Icon color={human} size={14} strokeWidth={1.75} />
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-[13px] text-muted-foreground"
      >
        {approval.summary}
      </Text>
      {answer ? (
        <Text numberOfLines={1} className="max-w-[40%] text-[13px] font-medium">
          {answer}
        </Text>
      ) : null}
      <Text
        className={cn(
          "font-mono text-[11px] text-faint",
          approval.status === "uncertain" && "text-attention",
        )}
      >
        {approvalLabels[approval.status]}
      </Text>
    </View>
  );
}
