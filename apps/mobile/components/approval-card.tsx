import { View } from "react-native";
import { answerSummary, approvalLabels } from "@zerolux/chat";
import type { Approval, FormAnswer, QuestionAnswer } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { McpForm, QuestionForm } from "@/components/request-answer";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

/** What an agent asks: a permission, a question or an MCP form. Only the owner answers. */
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
  decide: (decision: "allow" | "deny") => void;
  answer: (answer: QuestionAnswer | FormAnswer) => void;
}) {
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
          <View className="flex-row gap-2">
            <Button disabled={busy} onPress={() => decide("allow")}>
              <Text>Allow</Text>
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => decide("deny")}
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
          {approval.decision === "allow" ? "Allowed" : "Denied"} ·{" "}
          {approvalLabels[approval.status]}
        </Text>
      )}
    </View>
  );
}
