import { PlayIcon, SquareIcon } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  chooseVoice,
  designVoice,
  errorMessage,
  forgetVoice,
  useActionForm,
  useActions,
  useVoice,
  VOICE,
  voiceGreeting,
} from "@zerolux/chat";
import type { Actor, JsonSchema, VoiceProposal } from "@zerolux/chat";
import { ActionForm } from "@/components/action-form";
import { Listen } from "@/components/listen";
import { Eyebrow } from "@/components/meter";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { play, usePlaying } from "../src/voice";

/** The design action's input without the agent, which the profile gives. */
function withoutAgent(input: JsonSchema): JsonSchema {
  const { actor_id: _, ...properties } = input.properties ?? {};
  return {
    ...input,
    properties,
    required: input.required?.filter((key) => key !== "actor_id"),
  };
}

/** A language by the label the design action gives it, else by its code. */
const languageOf = (schema: JsonSchema | undefined, code: string) =>
  schema?.properties?.language?.oneOf?.find((o) => o.const === code)?.title ??
  code;

/**
 * An agent's own voice: heard, designed from a description, chosen among three proposals
 * heard first, or forgotten. Its person changes it.
 */
export function AgentVoice({
  agent,
  editable,
}: {
  agent: Actor;
  editable: boolean;
}) {
  const { url } = useSession();
  const { available, voices } = useVoice(url);
  const design = useActions(url, available).actions?.find(
    (a) => a.extension === VOICE && a.name === "design",
  );
  const schema = useMemo(() => design && withoutAgent(design.input), [design]);
  const [proposals, setProposals] = useState<VoiceProposal[]>();
  // With a voice, the form opens only to design another.
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  if (!available) return null;
  const current = voices?.find((v) => v.actor_id === agent.id);
  const act = (doing: string, work: () => Promise<unknown>) => {
    setBusy(doing);
    setError("");
    work()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(undefined));
  };
  return (
    <View className="gap-3">
      <Eyebrow>Voice</Eyebrow>
      {current ? (
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-sm">{current.description}</Text>
            <Text className="text-xs text-faint">
              Speaks best in {languageOf(schema, current.language)}
            </Text>
          </View>
          <Listen
            id={`voice:${agent.id}`}
            actorId={agent.id}
            text={voiceGreeting(agent.name, current.language)}
          />
        </View>
      ) : (
        <Text className="text-sm text-muted-foreground">
          {voices ? "No voice yet." : "Reading it…"}
        </Text>
      )}
      {!editable ? null : proposals ? (
        <Proposals
          proposals={proposals}
          busy={Boolean(busy)}
          choose={(proposal) =>
            act("Making the voice…", async () => {
              await chooseVoice(agent.id, proposal.id, url);
              setProposals(undefined);
              setAnother(false);
            })
          }
          again={() => setProposals(undefined)}
        />
      ) : current && !another ? (
        <Button
          variant="outline"
          disabled={Boolean(busy)}
          onPress={() => setAnother(true)}
        >
          <Text>Design another</Text>
        </Button>
      ) : schema ? (
        <Design
          schema={schema}
          busy={Boolean(busy)}
          cancel={current ? () => setAnother(false) : undefined}
          design={(input) =>
            act("Designing three voices…", async () =>
              setProposals(
                await designVoice(
                  agent.id,
                  String(input.description),
                  input.language ? String(input.language) : undefined,
                  url,
                ),
              ),
            )
          }
        />
      ) : null}
      {busy ? <Text className="text-xs text-faint">{busy}</Text> : null}
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {editable && current && !proposals && !another ? (
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(busy)}
          onPress={() =>
            Alert.alert(`Forget ${agent.name}'s voice?`, undefined, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Forget",
                style: "destructive",
                onPress: () =>
                  act("Forgetting it.", () => forgetVoice(agent.id, url)),
              },
            ])
          }
          className="self-start"
        >
          <Text className="text-[13px] font-medium text-destructive">
            Forget it
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A description in English, and the language it speaks best, as the extension asks them. */
function Design({
  schema,
  busy,
  design,
  cancel,
}: {
  schema: JsonSchema;
  busy: boolean;
  design: (input: Record<string, unknown>) => void;
  /** Back to the voice it has. */
  cancel?: () => void;
}) {
  const form = useActionForm(schema);
  return (
    <View className="gap-3">
      <ActionForm {...form} disabled={busy} />
      <Button
        disabled={busy}
        onPress={() => {
          const input = form.submit();
          if (input) design(input);
        }}
      >
        <Text>Design a voice</Text>
      </Button>
      {cancel ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={cancel}
          className="self-start"
        >
          <Text className="text-[13px] font-medium text-human-foreground">
            Keep this voice
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The three proposals, each heard before one is chosen. */
function Proposals({
  proposals,
  busy,
  choose,
  again,
}: {
  proposals: VoiceProposal[];
  busy: boolean;
  choose: (proposal: VoiceProposal) => void;
  again: () => void;
}) {
  const playing = usePlaying();
  const [muted, lit] = useCSSVariable([
    "--color-muted-foreground",
    "--color-agent-foreground",
  ]).map(String);
  return (
    <View className="gap-2">
      <View className="overflow-hidden rounded-md border border-border bg-card">
        {proposals.map((proposal, index) => {
          const id = `proposal:${proposal.id}`;
          const Icon = playing === id ? SquareIcon : PlayIcon;
          return (
            <View
              key={proposal.id}
              className={cn(
                "flex-row items-center gap-3 px-4 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${playing === id ? "Stop" : "Play"} voice ${index + 1}`}
                onPress={() => void play(id, () => [proposal])}
                hitSlop={8}
                className="size-8 items-center justify-center rounded-full border border-border active:opacity-60"
              >
                <Icon
                  color={playing === id ? lit : muted}
                  size={14}
                  strokeWidth={1.75}
                />
              </Pressable>
              <Text className="flex-1 text-[15px]">Voice {index + 1}</Text>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onPress={() => choose(proposal)}
              >
                <Text>Choose</Text>
              </Button>
            </View>
          );
        })}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={again}
        className="self-start"
      >
        <Text className="text-[13px] font-medium text-human-foreground">
          Describe it again
        </Text>
      </Pressable>
    </View>
  );
}
