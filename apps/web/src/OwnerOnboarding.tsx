import { useState } from "react";
import { ownerNameError } from "@zerolux/chat";
export { ownerNameError } from "@zerolux/chat";
import type { SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/presence";
import { useWorkspacesLink } from "@/instance";

export function OwnerOnboarding({
  busy,
  save,
  back: given,
}: {
  /** Where the workspaces are, to leave before naming yourself; none, nowhere to go. */
  back?: string | null;
  busy: boolean;
  save: (name: string) => Promise<boolean>;
}) {
  const workspaces = useWorkspacesLink();
  const back = given === undefined ? workspaces : given;
  const [name, setName] = useState("");
  const error = ownerNameError(name);
  const invalid = name.length > 0 && !!error;
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && !error) await save(name.trim());
  }
  return (
    <section
      aria-labelledby="owner-heading"
      className="mx-auto flex max-w-lg flex-col gap-4 py-12"
    >
      {back && (
        <Button
          variant="outline"
          className="self-start"
          render={<a href={back} />}
        >
          Back to workspaces
        </Button>
      )}
      <Eyebrow>Welcome / your workspace</Eyebrow>
      <h1 id="owner-heading" className="text-3xl font-semibold tracking-tight">
        What should we call you?
      </h1>
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
          aria-describedby={invalid ? "owner-name-help" : undefined}
          aria-invalid={invalid}
          disabled={busy}
          className="h-10"
        />
        {invalid && (
          <p id="owner-name-help" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
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
