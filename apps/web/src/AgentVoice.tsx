import { useState } from "react";
import {
  chooseVoice,
  designVoice,
  errorMessage,
  forgetVoice,
  useActions,
  useVoice,
  VOICE,
} from "@zerolux/chat";
import type { JsonSchema, VoiceProposal } from "@zerolux/chat";
import type { Actor } from "./api";
import { useReadAloud } from "./read-aloud";
import { Eyebrow } from "@/components/presence";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const languageName = (code: string) =>
  new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;

/** What the agent says to be heard: a greeting in the language its voice speaks best. */
const greeting = (name: string, language: string) =>
  language === "it" ? `Ciao, sono ${name}.` : `Hi, I'm ${name}.`;

type Step =
  | { kind: "describe" }
  | { kind: "designing" }
  | { kind: "proposals"; proposals: VoiceProposal[] }
  | { kind: "choosing"; proposals: VoiceProposal[]; proposal: string };

/**
 * An agent's own voice, which reads its messages aloud: heard here, and for its person made
 * from a description (three proposals, one chosen) or forgotten.
 */
export function AgentVoice({ agent, mine }: { agent: Actor; mine: boolean }) {
  const { available, voices } = useVoice();
  const { actions } = useActions();
  const aloud = useReadAloud();
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("");
  const [step, setStep] = useState<Step>({ kind: "describe" });
  const [error, setError] = useState("");
  if (!available) return null;
  const voice = voices?.find((v) => v.actor_id === agent.id);
  // The languages a voice is made in, as the extension offers them.
  const offered = actions?.find(
    (a) => a.extension === VOICE && a.name === "design",
  )?.input.properties?.language as JsonSchema | undefined;
  const languages = (offered?.enum ?? []).map(String);
  const chosenLanguage =
    language || String(offered?.default ?? languages[0] ?? "");

  async function attempt(work: () => Promise<void>, back: Step) {
    setError("");
    try {
      await work();
    } catch (failed) {
      setError(errorMessage(failed));
      setStep(back);
    }
  }

  return (
    <section
      aria-label="Voice"
      className="flex flex-col gap-3 border-b px-5 py-4"
    >
      <Eyebrow>Voice</Eyebrow>
      {voice ? (
        <>
          <p className="text-sm">{voice.description}</p>
          <p className="font-mono text-[11px] text-faint">
            Speaks best in {languageName(voice.language)}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={aloud.reading === agent.id}
              onClick={() =>
                aloud.reading === agent.id
                  ? aloud.stop()
                  : void aloud.read(
                      agent.id,
                      agent.id,
                      greeting(agent.name, voice.language),
                    )
              }
            >
              {aloud.reading === agent.id ? "Stop" : "Listen"}
            </Button>
            {mine && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() =>
                  void attempt(() => forgetVoice(agent.id), {
                    kind: "describe",
                  })
                }
              >
                Forget this voice
              </Button>
            )}
          </div>
          {aloud.failed?.id === agent.id && (
            <p role="alert" className="text-sm text-destructive">
              {aloud.failed.error}
            </p>
          )}
        </>
      ) : !mine ? (
        <p className="text-sm text-muted-foreground">
          {agent.name} has no voice yet.
        </p>
      ) : step.kind === "describe" || step.kind === "designing" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setStep({ kind: "designing" });
            void attempt(
              async () => {
                const proposals = await designVoice(
                  agent.id,
                  description.trim(),
                  chosenLanguage || undefined,
                );
                setStep({ kind: "proposals", proposals });
              },
              { kind: "describe" },
            );
          }}
        >
          <p className="text-sm text-muted-foreground">
            Describe how {agent.name} sounds, in English: three voices come from
            it, each saying hello, and you choose one.
          </p>
          <Label htmlFor="voice-description" className="sr-only">
            Description
          </Label>
          <Textarea
            id="voice-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="A calm, warm voice, medium-low, unhurried."
            rows={2}
          />
          {languages.length > 1 && (
            <div className="flex items-center gap-2">
              <Label htmlFor="voice-language">Speaks best in</Label>
              <NativeSelect
                id="voice-language"
                value={chosenLanguage}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {languages.map((code) => (
                  <NativeSelectOption key={code} value={code}>
                    {languageName(code)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <Button
            type="submit"
            size="sm"
            className="self-start"
            disabled={step.kind === "designing" || !description.trim()}
          >
            {step.kind === "designing"
              ? "Designing three voices… about half a minute"
              : "Design three voices"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Listen, and choose {agent.name}'s voice. It then reads a text with
            every sound of its language, to speak anything: about two minutes.
          </p>
          <ul className="flex flex-col gap-2">
            {step.proposals.map((proposal, index) => (
              <li key={proposal.id} className="flex items-center gap-3">
                <span className="w-16 font-mono text-[11px] text-faint">
                  Voice {index + 1}
                </span>
                <audio
                  controls
                  src={`data:${proposal.type};base64,${proposal.audio}`}
                  className="h-8 min-w-0 flex-1"
                />
                <Button
                  size="sm"
                  disabled={step.kind === "choosing"}
                  onClick={() => {
                    const proposals = step.proposals;
                    setStep({
                      kind: "choosing",
                      proposals,
                      proposal: proposal.id,
                    });
                    void attempt(
                      async () => {
                        await chooseVoice(agent.id, proposal.id);
                        setStep({ kind: "describe" });
                      },
                      { kind: "proposals", proposals },
                    );
                  }}
                >
                  {step.kind === "choosing" && step.proposal === proposal.id
                    ? "Making its voice…"
                    : "Choose"}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={step.kind === "choosing"}
            onClick={() => setStep({ kind: "describe" })}
          >
            Describe it again
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
