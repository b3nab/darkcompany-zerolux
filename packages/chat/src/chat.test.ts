import { expect, test } from "bun:test";
import {
  agentsForChat,
  chatPreview,
  directChat,
  authorColor,
  authorColors,
  dayLabel,
  freshness,
  mergeMessages,
  newId,
  outbox,
  receipt,
  refreshesSessions,
  pageBefore,
  parseEvent,
  isThread,
  listedSessions,
  liveSessions,
  threadsOf,
  workingIn,
} from "./chat";
import type { ChatSession, Conversation, Message, Outgoing } from "./chat";
import { ApiError } from "./client";
import type { Actor } from "./client";

const actor = (
  id: string,
  name: string,
  kind: Actor["kind"] = "agent",
): Actor => ({
  id,
  name,
  kind,
  owner_id: kind === "agent" ? "owner" : null,
  harness: kind === "agent" ? "claude-code" : null,
  created_at: 0,
  archived: false,
});
const actors = [
  actor("owner", "Owner", "human"),
  actor("aspen", "aspen"),
  actor("birch", "birch"),
  actor("codex", "Codex CLI"),
];
const group: Conversation = {
  id: "g",
  kind: "group",
  title: "General",
  paused: false,
  members: [
    { actor_id: "owner", session_id: null },
    { actor_id: "aspen", session_id: "s-aspen" },
    { actor_id: "birch", session_id: "s-birch" },
  ],
  last_seq: 0,
  last_message: null,
};
const dm: Conversation = {
  ...group,
  id: "d",
  kind: "dm",
  title: "aspen",
  members: [
    { actor_id: "owner", session_id: null },
    { actor_id: "aspen", session_id: "s-aspen-2" },
  ],
};
const msg = (seq: number, text = `m${seq}`): Message => ({
  id: `id-${seq}`,
  conversation_id: "g",
  seq,
  author_id: "owner",
  text,
  reply_to_delivery_id: null,
  created_at: seq,
  deliveries: [],
});
const bytes = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );

test("only well-formed chat events are accepted", () => {
  const event = {
    event_id: "e1",
    type: "message.created",
    conversation_id: "g",
    message_id: "m",
    seq: 3,
  };
  expect(parseEvent(bytes(event))).toEqual(event as never);
  expect(parseEvent(bytes("{not json"))).toBeUndefined();
  expect(parseEvent(bytes({ ...event, type: "prompt" }))).toBeUndefined();
  expect(parseEvent(bytes({ ...event, event_id: 1 }))).toBeUndefined();
});

test("pages merge by sequence and newer copies replace delivery states", () => {
  const updated = {
    ...msg(2),
    deliveries: [
      { id: "d", actor_id: "aspen", status: "read" as const, last_error: null },
    ],
  };
  const merged = mergeMessages([msg(1), msg(2)], [msg(3), updated, msg(1)]);
  expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  expect(merged[1]).toBe(updated);
});

test("the last page starts 100 sequences before the end", () => {
  expect(pageBefore(0)).toBe(0);
  expect(pageBefore(42)).toBe(0);
  expect(pageBefore(250)).toBe(150);
});

test("any live session of an agent may join any chat", () => {
  const session = (id: string, status: ChatSession["status"]): ChatSession => ({
    id,
    actor_id: id.split("-")[1]!,
    harness: "claude-code",
    native_session_id: id,
    title: id,
    workspace: "/w",
    status,
    attention_reason: null,
    waiting: 0,
    activity: "idle",
  });
  const sessions = [
    session("s-aspen-1", "connected"),
    session("s-aspen-2", "stopped"),
    session("s-aspen-3", "attention"),
    session("s-birch-1", "connected"),
  ];
  // Already in a group or a direct chat makes no difference.
  expect(liveSessions(sessions, "aspen").map((s) => s.id)).toEqual([
    "s-aspen-1",
    "s-aspen-3",
  ]);
  expect(liveSessions(sessions, "cedar")).toEqual([]);
});

test("an older response never overwrites a newer one", () => {
  const order = freshness();
  const working = order.start(); // A: asked first, answers "Working" last.
  const idle = order.start(); // B: asked later, answers "Idle" first.
  expect(order.accept("sessions", idle)).toBe(true);
  expect(order.accept("sessions", working)).toBe(false);
  // Each thing is ordered on its own, and in-order answers all apply.
  expect(order.accept("approvals", working)).toBe(true);
  const next = order.start();
  expect(order.accept("sessions", next)).toBe(true);
  expect(order.accept("sessions", next)).toBe(true);
});

test("reads and actions share one order: a late answer never undoes a newer state", async () => {
  const later = <T>() => {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>((r) => (resolve = r)), resolve };
  };
  const order = freshness();
  let shown = "";
  const show = (value: string) => {
    shown = value;
  };
  // The POST that stores a message answers after the GET that already saw it read.
  const post = later<string>(),
    get = later<string>();
  const posted = order.run("m:1", () => post.promise, show);
  const got = order.run("m:1", () => get.promise, show);
  get.resolve("read");
  await got;
  post.resolve("stored");
  await posted;
  expect(shown).toBe("read");
  // A GET started before Stop does not undo Stop's result.
  const before = later<string>(),
    stop = later<string>();
  const listed = order.run("sessions", () => before.promise, show);
  const stopped = order.run("sessions", () => stop.promise, show);
  stop.resolve("stopped");
  await stopped;
  before.resolve("connected");
  await listed;
  expect(shown).toBe("stopped");
});

test("stored and delivered messages refresh the waiting counts", () => {
  const events = [
    { type: "message.created", conversation_id: "c", message_id: "m", seq: 1 },
    { type: "delivery.changed", conversation_id: "c", message_id: "m" },
    { type: "session.changed", session_id: "s" },
  ] as const;
  for (const event of events)
    expect(refreshesSessions({ event_id: "e", ...event })).toBe(true);
  expect(
    refreshesSessions({
      event_id: "e",
      type: "approval.changed",
      approval_id: "a",
    }),
  ).toBe(false);
});

test("message IDs are v4 UUIDs without crypto.randomUUID, which plain HTTP lacks", () => {
  const ids = new Set(Array.from({ length: 1000 }, newId));
  expect(ids.size).toBe(1000);
  for (const id of ids)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});

test("a message the kernel did not receive is kept and sent again, same ID, in order", async () => {
  let down = true;
  const posted: string[] = [];
  let waiting: Outgoing[] = [];
  const refused: unknown[] = [];
  const box = outbox(
    async (m) => {
      posted.push(m.id);
      if (m.text === "refused")
        throw new ApiError("Conversation is paused", 409);
      if (down) throw new TypeError("Failed to fetch");
    },
    (next) => {
      waiting = next;
    },
    (error) => refused.push(error),
  );
  const message = (id: string, text = id): Outgoing => ({
    conversation_id: "c",
    id,
    text,
  });
  // Kernel restarting: the send resolves, the message is kept.
  await box.send(message("a"));
  await box.flush();
  expect(waiting.map((m) => m.id)).toEqual(["a"]);
  // A later one waits behind it, so the order holds.
  await box.send(message("b"));
  await box.send(message("c", "refused"));
  expect(waiting.map((m) => m.id)).toEqual(["a", "b", "c"]);
  // Back: sent in order with the same IDs; a refusal is dropped and reported.
  down = false;
  await box.flush();
  expect(waiting).toEqual([]);
  expect(posted.filter((id) => id === "a").length).toBeGreaterThan(1);
  expect(posted.slice(-3)).toEqual(["a", "b", "c"]);
  expect(refused).toHaveLength(1);
  // With the kernel up, a refusal is the sender's error, and nothing is kept.
  await expect(box.send(message("d", "refused"))).rejects.toThrow("paused");
  expect(waiting).toEqual([]);
});

test("a group chat shows one mark per message: sent, delivered to everyone, read by everyone", () => {
  const d = (status: Message["deliveries"][number]["status"]) => ({
    id: status,
    actor_id: status,
    status,
    last_error: null,
  });
  expect(receipt([])).toBeUndefined();
  expect(receipt([d("read"), d("stored")])).toBe("sent");
  expect(receipt([d("read"), d("uncertain")])).toBe("sent");
  expect(receipt([d("read"), d("notified")])).toBe("delivered");
  expect(receipt([d("read"), d("read")])).toBe("read");
});

test("messages are separated by day", () => {
  const now = new Date(2001, 5, 15, 10).getTime();
  expect(dayLabel(now - 3_600_000, now)).toBe("Today");
  expect(dayLabel(now - 86_400_000, now)).toBe("Yesterday");
  expect(dayLabel(now - 5 * 86_400_000, now)).toContain("2001");
});

test("a message the kernel saved, though its answer was lost, is not shown as not sent", async () => {
  let posts = 0;
  let waiting: Outgoing[] = [];
  const box = outbox(
    async () => {
      posts++;
      throw new TypeError("connection lost after the kernel saved it");
    },
    (next) => {
      waiting = next;
    },
    () => {},
  );
  await box.send({ conversation_id: "c", id: "m1", text: "hello" });
  expect(waiting.map((m) => m.id)).toEqual(["m1"]);
  // The chat's own read of the conversation now returns m1.
  box.received(["m0", "m1"]);
  expect(waiting).toEqual([]);
  const before = posts;
  await box.flush();
  expect(posts).toBe(before); // Not sent again.
});

test("a view cannot be replaced while the first send or an offline message is pending", async () => {
  let finish!: () => void;
  const box = outbox(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    () => {},
    () => {},
  );
  expect(box.pending()).toBe(false);
  const sent = box.send({ conversation_id: "a", id: "m1", text: "stay in A" });
  expect(box.pending()).toBe(true);
  finish();
  await sent;
  expect(box.pending()).toBe(false);

  const offline = outbox(
    async () => {
      throw new TypeError("offline");
    },
    () => {},
    () => {},
  );
  await offline.send({ conversation_id: "a", id: "m2", text: "not for B" });
  expect(offline.pending()).toBe(true);
  offline.close();
  expect(offline.pending()).toBe(true);
});

test("a message the kernel shows back before its send answer is lost is not queued", async () => {
  let answer!: (error: unknown) => void;
  let waiting: Outgoing[] = [];
  const box = outbox(
    () =>
      new Promise<void>((_, reject) => {
        answer = reject;
      }),
    (next) => {
      waiting = next;
    },
    () => {},
  );
  const sending = box.send({ conversation_id: "c", id: "m1", text: "hi" });
  box.received(["m1"]); // The chat's read returns it while the send still waits.
  answer(new TypeError("answer lost"));
  await sending;
  expect(waiting).toEqual([]);
});

test("disconnected, a resend under way stops before the next message", async () => {
  let down = true;
  let release!: () => void;
  const posted: string[] = [];
  const box = outbox(
    async (m) => {
      posted.push(m.id);
      if (down) throw new TypeError("kernel A restarting");
      if (m.id === "a1") await new Promise<void>((r) => (release = r));
    },
    () => {},
    () => {},
  );
  await box.send({ conversation_id: "c", id: "a1", text: "first" });
  await box.send({ conversation_id: "c", id: "a2", text: "second" });
  down = false;
  const flushing = box.flush(); // a1's resend now waits for its answer.
  await new Promise((r) => setTimeout(r, 0));
  box.close(); // The owner switches to kernel B.
  release();
  await flushing;
  // a2 waited behind a1 and is never sent: not to A after leaving it, nor anywhere else.
  expect(posted).not.toContain("a2");
  expect(posted.at(-1)).toBe("a1");
});

test("closed and opened again, as React does in development, it still resends", async () => {
  let down = true;
  let waiting: Outgoing[] = [];
  const posted: string[] = [];
  const box = outbox(
    async (m) => {
      posted.push(m.id);
      if (down) throw new TypeError("kernel restarting");
    },
    (next) => {
      waiting = next;
    },
    () => {},
  );
  box.open();
  box.close();
  box.open(); // setup → cleanup → setup
  await box.send({ conversation_id: "c", id: "m1", text: "offline" });
  expect(waiting.map((m) => m.id)).toEqual(["m1"]);
  down = false;
  await box.flush();
  expect(waiting).toEqual([]);
  expect(posted.at(-1)).toBe("m1");
});

test("an author keeps one color, the same on every client", () => {
  const id = "0b7c2f1e-0000-4000-8000-0000000000a1";
  expect(authorColor(id)).toBe(authorColor(id));
  expect(authorColors).toContain(authorColor(id));
  // The rule both clients rely on: the sum of the character codes, modulo six.
  expect(authorColor("a")).toBe("text-author-1");
  expect(authorColor("ab")).toBe("text-author-3");
});

test("the activity bubble shows only agents whose current turn serves this chat", () => {
  const general: Conversation = {
    id: "general",
    kind: "group",
    title: "General",
    paused: false,
    last_seq: 1,
    last_message: { author_id: "owner", text: "Hello", created_at: 1 },
    members: [
      { actor_id: "owner", session_id: null },
      { actor_id: "maple", session_id: "s-maple" },
      { actor_id: "cedar", session_id: "s-cedar" },
      { actor_id: "olive", session_id: "s-olive" },
    ],
  };
  const session = (
    id: string,
    activity: ChatSession["activity"],
    activity_conversation_id?: string | null,
  ): ChatSession => ({
    id,
    actor_id: id.slice(2),
    harness: "claude-code",
    native_session_id: id,
    title: id,
    workspace: "/w",
    status: "connected",
    attention_reason: null,
    waiting: 0,
    activity,
    activity_conversation_id,
  });
  expect(
    workingIn(general, [
      session("s-maple", "working", "general"),
      // Working, but for another chat, or for inputs from several chats.
      session("s-cedar", "working", "other"),
      session("s-olive", "working", null),
    ]),
  ).toEqual(["maple"]);
  expect(workingIn(general, [session("s-maple", "idle", "general")])).toEqual(
    [],
  );
  // Stopped, or needing attention, with the last Working it reported: no bubble.
  for (const status of ["stopped", "attention"] as const)
    expect(
      workingIn(general, [
        { ...session("s-maple", "working", "general"), status },
      ]),
    ).toEqual([]);

  // The list of chats says the same in place of the last message, paused or not.
  const name = (id: string) => id[0]!.toUpperCase() + id.slice(1);
  const busy = [
    session("s-maple", "working", "general"),
    session("s-cedar", "working", "general"),
  ];
  const preview = (
    sessions: ChatSession[],
    chat = general,
    conversations = [chat],
  ) => chatPreview(chat, conversations, sessions, name);
  expect(preview(busy)).toEqual({
    text: "Maple, Cedar are working",
    working: true,
  });
  expect(preview(busy.slice(0, 1), { ...general, paused: true })).toEqual({
    text: "Maple is working",
    working: true,
  });
  const idle = [session("s-maple", "idle", "general")];
  expect(preview(idle)).toEqual({ text: "Owner: Hello", working: false });
  expect(preview(idle, { ...general, paused: true }).text).toBe("Paused");
  // Threads are not listed: their work shows on their chat, each agent once.
  const thread: Conversation = {
    ...general,
    id: "thread",
    kind: "thread",
    parent_id: "general",
    members: [
      { actor_id: "maple", session_id: "s-maple-2" },
      { actor_id: "cedar", session_id: "s-cedar" },
    ],
  };
  expect(
    preview(
      [
        session("s-maple", "working", "general"),
        { ...session("s-maple", "working", "thread"), id: "s-maple-2" },
        session("s-cedar", "working", "thread"),
      ],
      general,
      [general, thread],
    ).text,
  ).toBe("Maple, Cedar are working");
});

test("a chat lists its threads, open ones first, and threads are not chats", () => {
  const chat = (
    id: string,
    extra: Partial<Conversation> = {},
  ): Conversation => ({
    id,
    kind: "group",
    title: id,
    paused: false,
    members: [],
    last_seq: 1,
    last_message: { author_id: "owner", text: "Hello", created_at: 1 },
    ...extra,
  });
  const general = chat("general");
  const closed = chat("closed", {
    kind: "thread",
    parent_id: "general",
    root_message_id: "m1",
    closed_at: 5,
    last_seq: 9,
  });
  const quiet = chat("quiet", {
    kind: "thread",
    parent_id: "general",
    root_message_id: "m2",
    last_seq: 2,
  });
  const busy = chat("busy", {
    kind: "thread",
    parent_id: "general",
    root_message_id: "m3",
    last_seq: 7,
  });
  const elsewhere = chat("elsewhere", {
    kind: "thread",
    parent_id: "other",
    root_message_id: "m4",
  });
  expect(
    threadsOf(general, [general, closed, quiet, busy, elsewhere]).map(
      (c) => c.id,
    ),
  ).toEqual(["busy", "quiet", "closed"]);
  expect([general, busy].map(isThread)).toEqual([false, true]);
});

test("the team lists live sessions, ones needing attention, and the latest stopped one ZeroLux can resume", () => {
  const s = (
    id: string,
    native: string,
    status: ChatSession["status"],
    origin: ChatSession["origin"],
    attention_reason: string | null = null,
  ): ChatSession => ({
    id,
    actor_id: "agent",
    harness: "claude-code",
    native_session_id: native,
    title: id,
    workspace: "/w",
    status,
    attention_reason,
    waiting: 0,
    origin,
  });
  const listed = listedSessions([
    s("live", "n1", "connected", "attached"),
    s("gone", "n2", "stopped", "attached"),
    s("unconfirmed", "n3", "stopped", "attached", "The turn may still finish."),
    s("owned-old", "n4", "stopped", "owned"),
    s("owned-new", "n4", "stopped", "owned"),
    s("owned-back", "n5", "stopped", "owned"),
    s("owned-live", "n5", "connected", "owned"),
    { ...s("pi-old", "n1", "stopped", "attached"), harness: "pi" },
    { ...s("pi-stopped", "n1", "stopped", "attached"), harness: "pi" },
  ]).map((x) => x.id);
  expect(listed).toEqual([
    "live",
    "unconfirmed",
    "owned-new",
    "owned-live",
    "pi-stopped",
  ]);
});

test("a new chat offers agents with a live session and reuses a direct chat", () => {
  const live = (id: string, actor_id: string, status: ChatSession["status"]) =>
    ({ id, actor_id, status }) as ChatSession;
  const sessions = [
    live("s1", "aspen", "connected"),
    live("s2", "birch", "stopped"),
  ];
  const ids = (list: Actor[]) => list.map((a) => a.id);
  // People and agents without a live session are left out...
  expect(ids(agentsForChat(actors, sessions, []))).toEqual(["aspen"]);
  // ...unless already picked, so they can be unpicked.
  expect(ids(agentsForChat(actors, sessions, ["birch"]))).toEqual([
    "aspen",
    "birch",
  ]);
  expect(
    ids(agentsForChat([{ ...actors[1]!, archived: true }], sessions, [])),
  ).toEqual([]);
  expect(directChat([group, dm], "owner", "aspen")?.id).toBe("d");
  expect(directChat([group, dm], "owner", "birch")).toBeUndefined();
});
