import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { Approvals } from "./Approvals";
import {
  AddAgent,
  ChatHome,
  ChatList,
  ChatView,
  NewConversation,
  sendsOnEnter,
} from "./ChatView";
import { Meetings } from "./Meetings";
import { Organization } from "./Org";
import { Storage } from "./Storage";
import { Tonight } from "./Tonight";
import { ChatAbout } from "./components/chat-about";
import { agentPresence } from "./presence";
import { Hire, HireForm, StartAgent, Team } from "./Team";
import type { Actor, AgentConnection, Task, Workspace } from "./api";
import type {
  Approval,
  ChatSession,
  Conversation,
  Discovery,
  Message,
} from "@zerolux/chat";
import { saveDraft, sessionState } from "@zerolux/chat";
import type { Chat, Storage as Files, StoredFile } from "@zerolux/chat";

/** Views render inside the app's router, as in the app. */
const renderToStaticMarkup = (view: ReactNode) =>
  render(<MemoryRouter>{view}</MemoryRouter>);

const OWNER = "0b7c2f1e-0000-4000-8000-000000000001";
const ASPEN = "0b7c2f1e-0000-4000-8000-0000000000a1";
const BIRCH = "0b7c2f1e-0000-4000-8000-0000000000a2";
const agent = (id: string, name: string): Actor => ({
  id,
  name,
  kind: "agent",
  owner_id: OWNER,
  harness: "claude-code",
  created_at: 0,
  archived: false,
});
const actors: Actor[] = [
  {
    id: OWNER,
    name: "Owner",
    kind: "human",
    owner_id: null,
    harness: null,
    created_at: 0,
    archived: false,
  },
  agent(ASPEN, "aspen"),
  agent(BIRCH, "birch"),
];
const session = (
  id: string,
  actor_id: string,
  status: ChatSession["status"] = "connected",
): ChatSession => ({
  id,
  actor_id,
  harness: "claude-code",
  native_session_id: `native-${id}-7f9c2d1e-uuid`,
  title: `${actor_id === ASPEN ? "aspen" : "birch"} work`,
  workspace: "/home/owner/github/zerolux",
  status,
  attention_reason:
    status === "attention"
      ? "The session was closed; Owner must reopen it."
      : null,
  waiting: 0,
});
const group: Conversation = {
  id: "c-group",
  kind: "group",
  title: "General",
  paused: false,
  members: [
    { actor_id: OWNER, session_id: null },
    { actor_id: ASPEN, session_id: "s-aspen" },
    { actor_id: BIRCH, session_id: "s-birch" },
  ],
  last_seq: 120,
  last_message: { author_id: ASPEN, text: "Group update", created_at: 120 },
};
const dm: Conversation = {
  id: "c-dm",
  kind: "dm",
  title: "aspen",
  paused: true,
  members: [
    { actor_id: OWNER, session_id: null },
    { actor_id: ASPEN, session_id: "s-aspen-dm" },
  ],
  last_seq: 2,
  last_message: { author_id: ASPEN, text: "Direct update", created_at: 2 },
};
const messages: Message[] = [
  {
    id: "m-21",
    conversation_id: group.id,
    seq: 21,
    author_id: OWNER,
    text: "Can you <b>check</b> the test?",
    reply_to_delivery_id: null,
    created_at: 1_790_000_000_000,
    deliveries: [
      { id: "d1", actor_id: ASPEN, status: "read", last_error: null },
      {
        id: "d2",
        actor_id: BIRCH,
        status: "uncertain",
        last_error: "Session closed while delivering",
      },
    ],
  },
  {
    id: "m-22",
    conversation_id: group.id,
    seq: 22,
    author_id: ASPEN,
    text: "Done: all green.",
    reply_to_delivery_id: "d1",
    created_at: 1_790_000_060_000,
    deliveries: [],
  },
];
const approval = (
  id: string,
  status: Approval["status"],
  decision: Approval["decision"] = null,
): Approval => ({
  id,
  actor_id: ASPEN,
  session_id: "s-aspen",
  conversation_id: group.id,
  delivery_id: "d1",
  summary: "Run bun test",
  details: { command: "bun test", html: "<script>alert(1)</script>" },
  status,
  decision,
  native_request_id: `native-${id}`,
  created_at: 1,
});
const nothing = async () => {};
function fakeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    conversations: [group, dm],
    sessions: [
      session("s-aspen", ASPEN),
      session("s-aspen-dm", ASPEN),
      session("s-birch", BIRCH),
    ],
    approvals: [],
    openId: undefined,
    messages: [],
    unsent: [],
    canLeave: () => true,
    seen: {},
    realtime: "live",
    error: "",
    select: () => {},
    loadEarlier: nothing,
    send: nothing,
    pause: nothing,
    close: nothing,
    create: async () => group,
    discover: async () => ({ sessions: [], errors: [] }),
    hire: nothing,
    startClaude: nothing,
    startCodex: nothing,
    startPi: nothing,
    takeoverPi: nothing,
    resume: nothing,
    stop: nothing,
    decide: nothing,
    addMember: nothing,
    rename: nothing,
    ...overrides,
  };
}
const perform = async () => true;
const noUuids = (html: string) =>
  expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

test("a group shows history and per-agent delivery states, and reaches every agent", () => {
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({ openId: group.id, messages })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toContain("Show earlier messages");
  expect(html).toContain("Can you &lt;b&gt;check&lt;/b&gt; the test?");
  // One compact mark per message; who has it, who read it and why is one tap away.
  expect(html).toMatch(/<span data-receipt="sent" title="Sent"/);
  expect(html).toMatch(/<details[^>]*><summary[^>]*><time/);
  expect(html).toContain("aspen · Read");
  expect(html).toMatch(
    /birch · Sent, not confirmed<small[^>]*>Session closed while delivering<\/small>/,
  );
  // A group chat names the author of others' messages, not of your own; agents speak in mono.
  expect(html).toMatch(
    /<strong class="[^"]*\bfont-mono\b[^"]*">aspen<\/strong>/,
  );
  expect(html).not.toContain(">Owner</strong>");
  expect(html).toContain("<li data-day");
  expect(html).toContain('aria-label="All chats"');
  expect(html).toContain(">Add agent<");
  // Nobody works and nothing waits in this fixture: the members.
  expect(html).toMatch(/<p class="[^"]*">Owner, aspen, birch<\/p>/);
  // Every owner message reaches all agents; each decides whether to reply.
  expect(html).not.toContain("Ask to reply");
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("will receive it");
  expect(html).toContain('data-mine="true"');
  expect(html).toContain(">Pause<");
  noUuids(html);
});

test("a paused DM reaches its agent on resume and never shows IDs", () => {
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({ openId: dm.id })}
      conversation={dm}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toContain("Paused: no agent is woken.");
  expect(html).toContain(">Resume<");
  expect(html).not.toContain("Add agent");
  noUuids(html);
});

test("a new chat lists agents with live sessions, or sends the owner to hire one", () => {
  const html = renderToStaticMarkup(
    <NewConversation
      chat={fakeChat()}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      open={() => {}}
      hire={() => {}}
    />,
  );
  expect(html).toContain("One agent");
  expect(html).toContain("aspen");
  expect(html).toContain("birch");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start chat<\/button>/);
  const empty = renderToStaticMarkup(
    <NewConversation
      chat={fakeChat({ sessions: [session("s-aspen", ASPEN, "stopped")] })}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      open={() => {}}
      hire={() => {}}
    />,
  );
  expect(empty).toContain("Hire an agent to start chatting.");
});

test("hiring lists found sessions by name, folder and activity, without IDs or commands", () => {
  const now = Date.now();
  const discovery: Discovery = {
    sessions: [
      {
        id: "found-old",
        harness: "codex",
        title: "Old refactor",
        workspace: "/home/owner/old",
        last_activity_at: now - 3 * 86_400_000,
        native_session_id: "019a0f00-aaaa-7bbb-8ccc-000000000001",
        availability: "attachable",
        can_create_context: false,
        reason: null,
      },
      {
        id: "found-closed",
        harness: "pi",
        title: "Closed pi",
        workspace: "/home/owner/pi",
        last_activity_at: now,
        native_session_id: "pi-native",
        availability: "attention",
        can_create_context: false,
        reason: "This pi session is not running. Open it again to hire it.",
      },
      {
        id: "found-aspen",
        harness: "claude-code",
        title: "aspen work",
        workspace: "/home/owner/github/zerolux",
        last_activity_at: now - 60_000,
        native_session_id: session("s-aspen", ASPEN).native_session_id,
        availability: "attachable",
        can_create_context: true,
        reason: null,
      },
    ],
    errors: [
      { harness: "codex", message: "The Codex app server is not running." },
    ],
  };
  const html = renderToStaticMarkup(
    <>
      <Hire
        chat={fakeChat({
          sessions: [
            session("s-aspen", ASPEN),
            session("s-birch", BIRCH, "attention"),
            { ...session("s-gone", BIRCH, "stopped"), title: "gone session" },
            {
              ...session("s-unconfirmed", ASPEN, "stopped"),
              title: "old aspen",
              attention_reason:
                "Stopped here; the running turn may still finish.",
            },
          ],
        })}
        actors={actors}
        busy={false}
        perform={perform}
        initialDiscovery={discovery}
      />
      <Team
        chat={fakeChat({
          sessions: [
            session("s-aspen", ASPEN),
            session("s-birch", BIRCH, "attention"),
            { ...session("s-gone", BIRCH, "stopped"), title: "gone session" },
            {
              ...session("s-unconfirmed", ASPEN, "stopped"),
              title: "old aspen",
              attention_reason:
                "Stopped here; the running turn may still finish.",
            },
          ],
        })}
        actors={actors}
        busy={false}
        perform={perform}
        hire={() => {}}
      />
    </>,
  );
  expect(html).toContain(
    "It can reply and resume this session until you press Stop.",
  );
  expect(html).toContain("Codex: The Codex app server is not running.");
  expect(html).toContain("Hired as aspen");
  expect(html).toContain("This pi session is not running.");
  expect(html).toContain("Hire…");
  // Grouped by project: the folder is named once, above its sessions.
  expect(html).toMatch(
    /<h4[^>]*>old <small[^>]*>\/home\/owner\/old<\/small><\/h4>/,
  );
  expect(html).toMatch(
    /<h4[^>]*>zerolux <small[^>]*>\/home\/owner\/github\/zerolux<\/small><\/h4>/,
  );
  expect(html.indexOf(">zerolux <small")).toBeLessThan(
    html.indexOf("aspen work"),
  );
  expect(html).toContain("3 days ago");
  // Attachable first, then most recent activity.
  expect(html.indexOf("aspen work")).toBeLessThan(html.indexOf("Old refactor"));
  expect(html.indexOf("Old refactor")).toBeLessThan(html.indexOf("Closed pi"));
  // Sessions that can't be hired are tucked away, still with their reason.
  expect(html).toContain("1 other session can&#x27;t be hired right now");
  expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Closed pi"));
  expect(html.indexOf("Old refactor")).toBeLessThan(html.indexOf("<details"));
  expect(html).toContain("Needs your attention");
  expect(html).toContain("The session was closed; Owner must reopen it.");
  // A stop without a reason disappears; an unconfirmed one keeps its note, not a new Stop.
  expect(html).not.toContain("gone session");
  expect(html).toContain("Stopped here; the running turn may still finish.");
  expect(html.match(/>Stop</g)).toHaveLength(2);
  // Each live agent can be renamed; a stopped one cannot.
  expect(html.match(/>Rename</g)).toHaveLength(2);
  expect(html).toContain(">Stopped<");
  expect(html).not.toContain("cargo run");
  noUuids(html);
});

test("permission requests show plain JSON details and stay until delivered", () => {
  const html = renderToStaticMarkup(
    <Approvals
      chat={fakeChat({
        approvals: [
          approval("a1", "pending"),
          approval("a2", "uncertain", "allow"),
          approval("a3", "delivered", "deny"),
          approval("a4", "resolved"),
        ],
      })}
      actors={actors}
      busy={false}
      perform={perform}
      show={() => {}}
    />,
  );
  expect(html).toContain("aspen asks: Run bun test");
  expect(html).toContain("While answering in «General»");
  expect(html).toContain("&quot;command&quot;: &quot;bun test&quot;");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain(">Allow<");
  expect(html).toContain(">Deny<");
  expect(html).toContain("Allowed · Decision may not have arrived");
  expect(html.match(/<article/g)).toHaveLength(2);
  expect(
    renderToStaticMarkup(
      <Approvals
        chat={fakeChat({ approvals: [approval("a3", "delivered", "deny")] })}
        actors={actors}
        busy={false}
        perform={perform}
        show={() => {}}
      />,
    ),
  ).toBe("");
});

test("hiring a stopped session again defaults to its previous agent", () => {
  const found = {
    id: "found-aspen",
    harness: "claude-code" as const,
    title: "aspen work",
    workspace: "/home/owner/github/zerolux",
    last_activity_at: null,
    native_session_id: "native",
    availability: "attachable" as const,
    can_create_context: true,
    reason: null,
  };
  const form = (previous?: string) =>
    renderToStaticMarkup(
      <HireForm
        session={found}
        previous={previous}
        agents={[agent(ASPEN, "aspen"), agent(BIRCH, "birch")]}
        busy={false}
        hire={perform}
        cancel={() => {}}
      />,
    );
  const again = form(ASPEN);
  expect(again).toMatch(
    /<option[^>]*selected=""[^>]*>aspen again, back in their chats<\/option>/,
  );
  expect(again).toContain("Another session of birch");
  expect(again).not.toContain("Agent name");
  expect(again).toContain("aspen will be able to reply and resume");
  const fresh = form();
  expect(fresh).toMatch(/<option[^>]*selected=""[^>]*>A new agent<\/option>/);
  expect(fresh).toContain("Agent name");
  expect(fresh).toContain("Claude Code will be able to reply");
});

test("the chat list shows the last author, escaped text and timestamp, with no time for empty chats", () => {
  const created_at = Date.UTC(2026, 9, 6, 9, 30);
  const latest = {
    ...group,
    last_message: {
      author_id: ASPEN,
      text: "<b>Latest update</b>",
      created_at,
    },
  };
  const empty = {
    ...group,
    id: "empty",
    title: "Empty chat",
    last_seq: 0,
    last_message: null,
  };
  const html = renderToStaticMarkup(
    <ChatList
      chat={fakeChat({ conversations: [empty, latest] })}
      actors={actors}
    />,
  );
  expect(html).toContain("aspen: &lt;b&gt;Latest update&lt;/b&gt;");
  expect(html).toContain(new Date(created_at).toISOString());
  expect(html.match(/<time\b/g)).toHaveLength(1);
  expect(html.indexOf('href="/chats/c-group"')).toBeLessThan(
    html.indexOf('href="/chats/empty"'),
  );
  noUuids(html);
});

test("the chats home marks finished steps; the list beside it shows every chat", () => {
  const home = (chat: Chat) =>
    renderToStaticMarkup(
      <ChatHome chat={chat} hire={() => {}} newChat={() => {}} />,
    );
  const ready = home(fakeChat({ conversations: [] }));
  expect(ready).toContain("3 agent sessions hired.");
  expect(ready.match(/data-done="true"/g)).toHaveLength(1);
  expect(ready.indexOf('data-done="true"')).toBeLessThan(
    ready.indexOf("Hire your agents"),
  );
  // The next step is the main action.
  expect(ready).toMatch(
    /<button[^>]*class="[^"]*\bbg-primary\b[^"]*"[^>]*>New chat<\/button>/,
  );
  const chatting = home(fakeChat());
  expect(chatting).toContain("Pick a chat.");
  expect(chatting.match(/data-done="true"/g)).toHaveLength(2);
  const list = renderToStaticMarkup(
    <ChatList chat={fakeChat()} actors={actors} />,
  );
  expect(list).toMatch(/<a[^>]*aria-label="New chat"[^>]*href="\/chats\/new"/);
  expect(list).toContain(">General<");
  expect(list).toContain(">Paused<");
  expect(list).toContain('aria-pressed="true"');
});

test("adding an agent to a group offers every hired non-member with a live session", () => {
  const CEDAR = "0b7c2f1e-0000-4000-8000-0000000000a3";
  const cedar: Actor = { ...agent(CEDAR, "cedar"), harness: "pi" };
  const add = (sessions: ChatSession[], people = [...actors, cedar]) =>
    renderToStaticMarkup(
      <AddAgent
        chat={fakeChat({ sessions })}
        conversation={group}
        actors={people}
        busy={false}
        perform={perform}
        hire={() => {}}
        done={() => {}}
      />,
    );
  const base = [session("s-aspen", ASPEN), session("s-birch", BIRCH)];
  const ready = add([
    ...base,
    { ...session("s-cedar", CEDAR), title: "cedar work" },
  ]);
  expect(ready).toContain("cedar");
  expect(ready).toContain("cedar work");
  expect(ready).toContain(">Add<");
  // Members are not offered again.
  expect(ready).not.toContain(">aspen<");
  // cedar's only session already serves a chat with other people: it joins this one too.
  const busyCedar = add([...base, { ...session("s-aspen-dm", CEDAR) }]);
  expect(busyCedar).toContain("cedar");
  expect(busyCedar).toContain(">Add<");
  expect(busyCedar).not.toContain("already used");
  // Nobody left to add.
  expect(add(base, actors)).toContain(
    "Every hired agent is already in this chat.",
  );
  noUuids(ready);
});

test("a message the kernel did not receive stays visible until it goes out", () => {
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({
        openId: group.id,
        unsent: [
          {
            conversation_id: group.id,
            id: "u1",
            text: "sent while restarting",
          },
          { conversation_id: dm.id, id: "u2", text: "another chat" },
        ],
      })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toMatch(/<li data-mine="true" data-unsent="true"/);
  expect(html).toContain("sent while restarting");
  expect(html).toContain("Not sent yet: it goes out when ZeroLux is back");
  expect(html).not.toContain("another chat");
});

test("Enter sends, Shift Enter adds a line, and nothing goes while a word is being composed", () => {
  const press = (key: string, shiftKey = false, isComposing = false) =>
    sendsOnEnter({ key, shiftKey, isComposing });
  expect(press("Enter")).toBe(true);
  expect(press("Enter", true)).toBe(false);
  expect(press("Enter", false, true)).toBe(false);
  expect(press("a")).toBe(false);
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({ openId: group.id })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toContain('aria-label="Message"');
  expect(html).not.toContain("Enter sends");
  expect(html).not.toContain("adds a line");
});

test("the chat header shows how many messages have not reached each agent yet", () => {
  // The kernel counts the whole queue, not just the messages loaded here.
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({
        openId: group.id,
        messages: [],
        sessions: [
          session("s-aspen", ASPEN),
          { ...session("s-birch", BIRCH), waiting: 2 },
        ],
      })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toMatch(/<p class="[^"]*">2 waiting for birch<\/p>/);
});

test("activity is shown as working or idle, and unknown activity is never shown as idle", () => {
  const s = session("s-aspen", ASPEN);
  expect(sessionState({ ...s, activity: "working" })).toBe("Working…");
  expect(sessionState({ ...s, activity: "idle" })).toBe("Idle");
  expect(sessionState({ ...s, activity: null })).toBe(
    "Connected · activity unknown",
  );
  expect(sessionState({ ...s, activity: "working", status: "attention" })).toBe(
    "Needs your attention",
  );
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({
        openId: group.id,
        sessions: [{ ...session("s-aspen", ASPEN), activity: "working" }],
      })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(html).toMatch(
    /<p data-working="true" class="[^"]*">aspen working…<\/p>/,
  );
});

test("the organization shows each person with the agents they own, and what each is doing", () => {
  const ada: Actor = { ...actors[0]!, id: "ada", name: "Ada" };
  const lin: Actor = {
    id: "lin",
    name: "lin",
    kind: "agent",
    owner_id: "ada",
    harness: "pi",
    created_at: 0,
    archived: false,
  };
  const retired: Actor = { ...lin, id: "old", name: "retired", archived: true };
  const workspace: Workspace = {
    workspace: {
      id: "workspace",
      name: "Workspace",
      created_at: 0,
    },
    actors: [...actors, ada, lin, retired],
    projects: [],
    tasks: [],
    connections: [],
    onboarding_required: false,
  };
  const chat = fakeChat({
    sessions: [
      {
        ...session("s-aspen", ASPEN),
        activity: "working",
        activity_conversation_id: group.id,
      },
      session("s-birch", BIRCH, "stopped"),
    ],
  });
  const at = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Organization workspace={workspace} chat={chat} />
      </MemoryRouter>,
    );
  // Every person heads a tree with their own agents; a retired agent is gone.
  const html = at("/org");
  expect(html.indexOf(">Ada<")).toBeGreaterThan(html.indexOf(">Owner<"));
  expect(html).toContain(">2 agents<");
  expect(html).toContain(">1 agent<");
  expect(html).not.toContain("retired");
  // The owner's profile opens first and says what each of their agents is doing.
  expect(html).toMatch(/<p[^>]*>Owner<\/p>/);
  expect(html).toContain("Working…");
  // A stopped agent is still in the organization, just not connected.
  expect(html).toContain("Not connected");
  // An agent's profile: its owner, the chat it answers in, and its one-to-one chat.
  const profile = at(`/org?actor=${ASPEN}`);
  expect(profile).toContain("Owner</button>");
  expect(profile).toContain("Answering in General");
  expect(profile).toContain('href="/chats/c-dm"');
  expect(profile).toContain('href="/team"');
  noUuids(html);
  noUuids(profile);
});

test("an agent's presence prefers a connected session, then a task worker, the same everywhere", () => {
  const worker: AgentConnection = {
    id: "w",
    actor_id: BIRCH,
    project_id: "p",
    mode: "process",
    workspace: "/w",
    session_id: null,
    connected_at: 1,
    lease_expires_at: Date.now() + 60_000,
    disconnected_at: null,
  };
  // A task worker without a chat session is connected, not missing.
  expect(agentPresence(BIRCH, [], [worker])).toEqual({
    label: "Task worker connected",
    tone: "connected",
  });
  // A session needing attention, however busy it last was, loses to a connected one.
  const stale = {
    ...session("s-old", ASPEN, "attention"),
    activity: "working" as const,
  };
  const idle = { ...session("s-new", ASPEN), activity: "idle" as const };
  expect(agentPresence(ASPEN, [stale, idle], [])).toEqual({
    label: "Idle",
    tone: "connected",
  });
  // Alone, it shows its attention, never painted as working.
  expect(agentPresence(ASPEN, [stale], [])).toEqual({
    label: "Needs your attention",
    tone: "attention",
  });
  expect(agentPresence(ASPEN, [], [])).toEqual({
    label: "Not connected",
    tone: "stopped",
  });
});

test("a chat shows the text you left unsent in it", () => {
  saveDraft(group.id, "half a thought");
  const html = renderToStaticMarkup(
    <ChatView
      chat={fakeChat({ openId: group.id })}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  saveDraft(group.id, "");
  expect(html).toMatch(
    /<textarea[^>]*aria-label="Message"[^>]*>half a thought<\/textarea>/,
  );
});

test("chat forms are sent by their own submit button", () => {
  const submits = (html: string) =>
    [...html.matchAll(/<button[^>]*type="submit"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );
  expect(
    submits(
      renderToStaticMarkup(
        <ChatView
          chat={fakeChat({ openId: group.id })}
          conversation={group}
          actors={actors}
          ownerId={OWNER}
          busy={false}
          perform={perform}
          hire={() => {}}
          storage={files()}
          capabilities={[]}
        />,
      ),
    ),
  ).toEqual(["Send"]);
  expect(
    submits(
      renderToStaticMarkup(
        <NewConversation
          chat={fakeChat()}
          actors={actors}
          ownerId={OWNER}
          busy={false}
          perform={perform}
          open={() => {}}
          hire={() => {}}
        />,
      ),
    ),
  ).toEqual(["Start chat"]);
  expect(
    submits(
      renderToStaticMarkup(
        <HireForm
          session={{
            id: "found",
            harness: "claude-code",
            title: "aspen work",
            workspace: "/home/owner/github/zerolux",
            last_activity_at: null,
            native_session_id: "native",
            availability: "attachable",
            can_create_context: true,
            reason: null,
          }}
          agents={[]}
          busy={false}
          hire={perform}
          cancel={() => {}}
        />,
      ),
    ),
  ).toEqual(["Hire"]);
});

test("a bubble under the last message shows who is working on this chat", () => {
  const view = (sessions: ChatSession[]) =>
    renderToStaticMarkup(
      <ChatView
        chat={fakeChat({ openId: group.id, messages, sessions })}
        conversation={group}
        actors={actors}
        ownerId={OWNER}
        busy={false}
        perform={perform}
        hire={() => {}}
        storage={files()}
        capabilities={[]}
      />,
    );
  const html = view([
    {
      ...session("s-aspen", ASPEN),
      activity: "working",
      activity_conversation_id: group.id,
    },
    {
      ...session("s-birch", BIRCH),
      activity: "working",
      activity_conversation_id: dm.id,
    },
  ]);
  expect(html).toMatch(
    /<li data-activity="true"[^>]*>[\s\S]*aspen is working<\/li>/,
  );
  // The bubble comes after the last message.
  expect(html.indexOf("data-activity")).toBeGreaterThan(
    html.indexOf("Done: all green."),
  );
  // birch works for another chat: no bubble here.
  expect(html).not.toContain("birch is working");
  expect(
    view([
      {
        ...session("s-aspen", ASPEN),
        activity: "idle",
        activity_conversation_id: group.id,
      },
    ]),
  ).not.toContain("data-activity");
});

test("a chat shows its threads under their message and lists the open ones; a thread is read-only for the owner", () => {
  const thread: Conversation = {
    id: "t-tests",
    kind: "thread",
    title: "Which tests fail",
    paused: false,
    last_seq: 3,
    last_message: { author_id: ASPEN, text: "Thread update", created_at: 3 },
    parent_id: group.id,
    root_message_id: "m-21",
    closed_at: null,
    members: [
      { actor_id: ASPEN, session_id: "s-aspen" },
      { actor_id: BIRCH, session_id: "s-birch" },
    ],
  };
  const closed: Conversation = {
    ...thread,
    id: "t-old",
    title: "Old question",
    root_message_id: "m-22",
    closed_at: 1,
  };
  const chat = fakeChat({
    conversations: [group, dm, thread, closed],
    openId: group.id,
    messages,
  });
  const parent = renderToStaticMarkup(
    <ChatView
      chat={chat}
      conversation={group}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  // Under the message it is about, with who coordinates in it.
  expect(parent).toMatch(
    /Can you &lt;b&gt;check&lt;\/b&gt; the test\?[\s\S]*<a[^>]*href="\/chats\/t-tests"[^>]*>[\s\S]*Which tests fail[\s\S]*aspen, birch/,
  );
  // Open threads at a glance; a closed one only under its message.
  const strip =
    parent.match(/<nav aria-label="Open threads"[\s\S]*?<\/nav>/)?.[0] ?? "";
  expect(strip).toContain("Which tests fail");
  expect(strip).not.toContain("Old question");
  expect(parent).toMatch(
    /data-closed="true"[^>]*>[\s\S]*Old question[\s\S]*· closed/,
  );

  const view = renderToStaticMarkup(
    <ChatView
      chat={{ ...chat, openId: thread.id, messages: [] }}
      conversation={thread}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(view).toMatch(
    /href="\/chats\/c-group"[^>]*aria-label="Back to General"|aria-label="Back to General"[^>]*href="\/chats\/c-group"/,
  );
  expect(view).toContain("Thread in «General»");
  expect(view).toContain(
    "Agents coordinate here; the answer comes in «General».",
  );
  // A thread rests with its chat: paused there, paused here, resumed there.
  const resting = renderToStaticMarkup(
    <ChatView
      chat={{ ...chat, openId: thread.id, messages: [] }}
      conversation={{ ...thread, paused: true }}
      actors={actors}
      ownerId={OWNER}
      busy={false}
      perform={perform}
      hire={() => {}}
      storage={files()}
      capabilities={[]}
    />,
  );
  expect(resting).toContain(
    "Paused with «General»: no agent is woken here until you resume that chat.",
  );
  expect(resting).not.toContain(">Resume<");
  // The owner reads it; only its agents write in it.
  expect(view).not.toContain('aria-label="Message"');
  expect(view).not.toContain(">Pause<");
  // The owner may close it; a closed one cannot be closed again.
  expect(view).toContain(">Close thread<");
  expect(view).not.toContain("Add agent");
  noUuids(view);

  // Threads are reached from their chat, not listed with the chats.
  const home = renderToStaticMarkup(
    <ChatHome chat={chat} hire={() => {}} newChat={() => {}} />,
  );
  expect(home).not.toContain("Which tests fail");
});

test("starting an agent asks for a harness, an agent, a folder and how it asks permission", () => {
  const html = renderToStaticMarkup(
    <StartAgent
      chat={fakeChat({})}
      actors={actors}
      folders={["/home/owner/app", "/home/owner/app", "/home/owner/site"]}
      busy={false}
      perform={perform}
    />,
  );
  expect(html).toContain("Start a new agent");
  expect(html).toContain("What you write in your chats reaches it as yours");
  // Claude Code first; Codex can be chosen, with Codex's own settings as the default.
  expect(html).toContain(">Claude Code<");
  expect(html).toContain(">Codex<");
  expect(html).toContain('value="pi">pi</option>');
  expect(html).toContain("Another session of aspen");
  expect(html).toContain(">Folder<");
  // Each folder suggested once.
  expect(html.match(/value="\/home\/owner\/app"/g)).toHaveLength(1);
  for (const mode of [
    "Asks you when Claude Code needs your permission",
    "Edits files without asking",
    "Plans and explains; changes nothing",
    "Claude Code decides on its own",
  ])
    expect(html).toContain(mode);
  expect(html).not.toContain("Codex settings");
  // Nothing starts without a folder.
  expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Start</);
  noUuids(html);
});

test("managed Claude and terminal pi offer Resume; other attached sessions do not", () => {
  const html = renderToStaticMarkup(
    <Team
      chat={fakeChat({
        sessions: [
          { ...session("s-owned", ASPEN, "stopped"), origin: "owned" },
          { ...session("s-stuck", BIRCH, "attention"), origin: "owned" },
          {
            ...session("s-terminal-pi", ASPEN, "stopped"),
            harness: "pi",
            origin: "attached",
          },
          {
            ...session("s-had", BIRCH, "stopped"),
            origin: "attached",
            attention_reason:
              "Stopped here; the running turn may still finish.",
          },
        ],
      })}
      actors={actors}
      busy={false}
      perform={perform}
      hire={() => {}}
    />,
  );
  expect(html.match(/>Resume</g)).toHaveLength(3);
  expect(html).toContain("Stopped here; the running turn may still finish.");
});

test("only connected attached pi offers cooperative terminal takeover", () => {
  const html = renderToStaticMarkup(
    <Team
      chat={fakeChat({
        sessions: [
          {
            ...session("terminal", ASPEN, "connected"),
            harness: "pi",
            origin: "attached",
          },
          {
            ...session("managed", BIRCH, "connected"),
            harness: "pi",
            origin: "owned",
          },
          {
            ...session("unavailable", ASPEN, "attention"),
            harness: "pi",
            origin: "attached",
          },
          { ...session("claude", BIRCH, "connected"), origin: "attached" },
        ],
      })}
      actors={actors}
      busy={false}
      perform={perform}
      hire={() => {}}
    />,
  );
  expect(html.match(/>Take over</g)).toHaveLength(1);
});

const task = (
  id: string,
  title: string,
  assignee_id: string,
  status: Task["status"],
): Task => ({
  id,
  project_id: "p-zerolux",
  title,
  description: "",
  assignee_id,
  status,
  review_note: "",
  created_at: 1,
  updated_at: 2,
});
const company: Workspace = {
  workspace: {
    id: "workspace",
    name: "Workspace",
    created_at: 0,
  },
  actors,
  projects: [
    { id: "p-zerolux", name: "ZeroLux", description: "", created_at: 1 },
  ],
  tasks: [
    task("t-review", "Ship the theme", ASPEN, "review"),
    task("t-run", "Port the org chart", BIRCH, "running"),
    task("t-done", "Pick the fonts", ASPEN, "done"),
  ],
  connections: [],
  onboarding_required: false,
};

test("tonight lists what waits for the owner, what runs now and how the projects stand", () => {
  const html = renderToStaticMarkup(
    <Tonight
      workspace={company}
      chat={fakeChat({
        approvals: [
          approval("a-open", "pending"),
          approval("a-done", "delivered", "allow"),
        ],
        sessions: [
          {
            ...session("s-aspen", ASPEN),
            activity: "working",
            activity_conversation_id: group.id,
          },
          session("s-birch", BIRCH, "attention"),
        ],
      })}
      owner={actors[0]!}
      busy={false}
      perform={perform}
      capabilities={[]}
    />,
  );
  // A permission request, a task in review and a stuck session; a decided request is gone.
  expect(html).toContain("3 things need you.");
  expect(html).toContain("Run bun test");
  expect(html).toContain(">Allow<");
  expect(html).toContain(">Deny<");
  expect(html).toContain("Ship the theme");
  expect(html).toContain('href="/projects/p-zerolux?task=t-review"');
  expect(html).toContain("The session was closed; Owner must reopen it.");
  // Running now: an agent answering in a chat, and a task a worker runs.
  expect(html).toContain("Answering in General");
  expect(html).toContain("Port the org chart");
  expect(html).toContain("1 / 3 done");
  // A kernel without meetings shows no live call.
  expect(html).not.toContain(" is live");
  noUuids(html);
});

const files = (overrides: Partial<Files> = {}): Files => ({
  available: true,
  files: [],
  error: "",
  upload: nothing,
  ...overrides,
});
const file = (id: string, name: string, conversation_id: string | null) =>
  ({
    id,
    name,
    folder: "",
    size: 2048,
    content_type: "text/markdown",
    created_by: ASPEN,
    updated_at: 1,
    conversation_id,
  }) satisfies StoredFile;

test("storage and meetings say so when the kernel has neither", () => {
  const storage = (available: boolean) =>
    renderToStaticMarkup(
      <Storage
        workspace={company}
        chat={fakeChat()}
        storage={files({ available })}
      />,
    );
  expect(storage(false)).toContain("This kernel has no storage yet.");
  expect(storage(true)).toContain("No files yet.");
  const meetings = renderToStaticMarkup(
    <Meetings
      workspace={company}
      chat={fakeChat()}
      owner={actors[0]!}
      capabilities={[]}
    />,
  );
  expect(meetings).toContain("This kernel has no meeting rooms yet.");
});

test("a chat's Meet opens a meeting for that chat, titled after it", () => {
  const html = render(
    <MemoryRouter initialEntries={[`/meetings?chat=${group.id}`]}>
      <Meetings
        workspace={company}
        chat={fakeChat()}
        owner={actors[0]!}
        capabilities={["meetings-v1"]}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("A meeting for General");
  expect(html).toMatch(/<input[^>]*name="title"[^>]*value="General"/);
  expect(html).toContain("No meeting right now.");
});

test("beside a chat: who is in it and what each is doing, its tasks and its files", () => {
  const html = renderToStaticMarkup(
    <ChatAbout
      conversation={group}
      actors={actors}
      sessions={[
        { ...session("s-aspen", ASPEN), activity: "working" },
        session("s-birch", BIRCH, "stopped"),
      ]}
      storage={files({
        files: [
          file("f-notes", "notes.md", group.id),
          file("f-other", "elsewhere.md", dm.id),
        ],
      })}
    />,
  );
  expect(html).toContain("Members · 3");
  expect(html).toContain("Person");
  expect(html).toContain("Claude Code");
  expect(html).toContain("Working…");
  expect(html).toContain("Stopped");
  // Only the files shared in this chat.
  expect(html).toContain("notes.md");
  expect(html).toContain("2 KB");
  expect(html).not.toContain("elsewhere.md");
  noUuids(html);
});
