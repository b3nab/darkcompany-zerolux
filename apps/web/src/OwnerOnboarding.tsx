import { useState } from "react";
import type { SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/presence";

export function ownerNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter your name to continue.";
  if (name.toLowerCase() === "local owner") return "Use your own name.";
  if (new TextEncoder().encode(name).length > 200)
    return "Your name must be at most 200 UTF-8 bytes.";
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name))
    return "Your name cannot contain control characters.";
}

export function OwnerOnboarding({
  busy,
  save,
}: {
  busy: boolean;
  save: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const error = ownerNameError(name);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && !error) await save(name.trim());
  }
  return (
    <section
      aria-labelledby="owner-heading"
      className="mx-auto flex max-w-lg flex-col gap-4 py-12"
    >
      <Eyebrow>Welcome / your workspace</Eyebrow>
      <h1 id="owner-heading" className="text-3xl font-semibold tracking-tight">
        First, what should we call you?
      </h1>
      <p className="text-muted-foreground">
        You are the owner of this workspace. Set your name before creating
        projects or hiring your first agent. No placeholder agents will be
        added.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <Label htmlFor="owner-name">Your name</Label>
        <Input
          id="owner-name"
          name="name"
          autoComplete="name"
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your name"
          aria-describedby="owner-name-help"
          aria-invalid={name.length > 0 && !!error}
          disabled={busy}
          className="h-10"
        />
        <p id="owner-name-help" className="text-sm text-muted-foreground">
          {name.length > 0 && error
            ? error
            : "Your agents will be shown as owned by you. You can use your preferred display name."}
        </p>
        <Button
          type="submit"
          size="lg"
          className="self-start"
          disabled={busy || !!error}
        >
          {busy ? "Saving…" : "Save name & continue"}
        </Button>
      </form>
    </section>
  );
}
