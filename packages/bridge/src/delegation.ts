/** The sessions an agent's session starts, follows and steers to delegate work. */
type Call = <T>(path: string, body?: unknown) => Promise<T>;

interface Session {
  id: string;
  title: string;
  harness: string;
  workspace: string;
  status: string;
  activity?: string | null;
  last_turn?: string | null;
  summary?: string | null;
}
interface Event {
  type: string;
  text?: string;
}

/** A new session of a harness in a folder, with the work to do as its first input. */
export async function startSession(
  call: Call,
  input: {
    harness: string;
    workspace: string;
    prompt: string;
    model?: string;
    effort?: string;
  },
) {
  const { session } = await call<{ session: Session }>("/sessions", {
    harness: input.harness,
    workspace: input.workspace,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });
  await call(`/sessions/${encodeURIComponent(session.id)}/input`, {
    text: input.prompt,
  });
  return session;
}

/** Where a delegated session is, and what it last answered. */
export async function readSession(call: Call, id: string) {
  const path = `/sessions/${encodeURIComponent(id)}`;
  const { session } = await call<{ session: Session }>(path);
  const { events } = await call<{ events: Event[] }>(
    `${path}/events?before=${Number.MAX_SAFE_INTEGER}`,
  );
  const last = events.map((event) => event.type).lastIndexOf("input");
  const answer = events
    .slice(last + 1)
    .filter((event) => event.type === "text" && event.text)
    .map((event) => event.text)
    .join("\n\n");
  return {
    id: session.id,
    title: session.title,
    harness: session.harness,
    status: session.status,
    working: session.activity === "working",
    last_turn: session.last_turn ?? null,
    answer: answer || session.summary || "",
  };
}

/** More words for a delegated session: into its turn, after it, or instead of it. */
export async function sendSession(
  call: Call,
  id: string,
  text: string,
  mode: "steer" | "queue" | "interrupt" = "steer",
) {
  await call(`/sessions/${encodeURIComponent(id)}/input`, { text, mode });
}

/** Stops a delegated session. */
export async function stopSession(call: Call, id: string) {
  await call(`/sessions/${encodeURIComponent(id)}/stop`, {});
}
