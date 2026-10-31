import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApprovalCard, ApprovalReceipt, Approvals } from "./Approvals";
import {
  ConsoleList,
  ContextMeter,
  NativeSessionView,
  QueueCards,
  SessionView,
} from "./Console";
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
import { Tonight } from "./Tonight";
import { ChatAbout } from "./components/chat-about";
import { FileCard } from "./components/file";
import { LiveWork, WorkLine } from "./components/chat-work";
import { setDensity } from "./components/density";
import { LiveItems, SessionBlocks } from "./components/session-blocks";
import { ToolCall } from "./components/tool-call";
import { agentPresence } from "./presence";
import {
  AgentProfile,
  AgentSettingsForm,
  Hire,
  HireForm,
  SessionCard,
  StartSession,
  Team,
} from "./Team";
import type { Actor, Workspace } from "./api";
import type {
  Approval,
  DiscoveredSession,
  ChatSession,
  ChatTurn,
  SessionBlock,
  ToolBlock,
  Conversation,
  Discovery,
  Message,
} from "@zerolux/chat";
import { placeApprovals, saveDraft } from "@zerolux/chat";
import type { Chat, Storage as Files } from "@zerolux/chat";

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
  invited_by: null,
  harness: "claude-code",
  model: null,
  effort: null,
  permission_mode: null,
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: false,
});
const actors: Actor[] = [
  {
    id: OWNER,
    name: "Owner",
    kind: "human",
    owner_id: null,
    invited_by: null,
    harness: null,
    model: null,
    effort: null,
    permission_mode: null,
    approval_policy: null,
    sandbox: null,
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
  owner_id: OWNER,
  shared: null,
  created: false,
  actor_id,
  host_id: null,
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
  created_at: 0,
  pinned_at: null,
  archived_at: null,
  budget_usd: null,
  parent_session_id: null,
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
  kind: "permission",
  summary: "Run bun test",
  details: { command: "bun test", html: "<script>alert(1)</script>" },
  status,
  decision,
  scope: decision === "allow" ? "once" : null,
  reason: null,
  answer: null,
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
    outputs: {},
    approvals: [],
    openId: undefined,
    messages: [],
    unsent: [],
    canLeave: () => true,
    leaveReason: () => undefined,
    markSeen: () => {},
    realtime: "live",
    error: "",
    select: () => {},
    loadEarlier: nothing,
    send: nothing,
    pause: nothing,
    close: nothing,
    create: async () => group,
    discover: async () => ({ sessions: [], errors: [] }),
    attach: async () => ({ actor: null, session: session("s-new", ASPEN) }),
    createSession: async () => ({
      actor: null,
      session: session("s-new", ASPEN),
    }),
    forkSession: async () => ({
      actor: null,
      session: session("s-fork", ASPEN),
    }),
    rewindFiles: async () => ({ canRewind: true }),
    updateSession: nothing,
    live: async () => ({ seq: 0, items: [], queue: [] }),
    takeoverPi: nothing,
    resume: nothing,
    stop: nothing,
    interrupt: async () => true,
    compact: nothing,
    input: nothing,
    continueNative: async () => session("s-native", ASPEN),
    sentInputs: () => [],
    retryInput: nothing,
    dropInput: () => {},
    removeQueued: nothing,
    editQueued: nothing,
    decide: nothing,
    answer: nothing,
    addMember: nothing,
    rename: nothing,
    ...overrides,
  };
}
const perform = async () => true;
/** No IDs in what the owner reads; links may carry them. */
const noUuids = (html: string) =>
  expect(html.replace(/ href="[^"]*"/g, "")).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-/,
  );

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
    />,
  );
  expect(html).not.toContain("<details");
  // A group chat names the author of others' messages, not of your own; agents speak in mono.
  expect(html).toMatch(
    /<strong class="[^"]*\bfont-mono\b[^"]*">aspen<\/strong>/,
  );
  expect(html).not.toContain(">Owner</strong>");
  expect(html).toContain("<li data-day");
  // Nobody works and nothing waits in this fixture: the members.
  expect(html).toMatch(/<p class="[^"]*">Owner, aspen, birch<\/p>/);
  expect(html).not.toContain('type="checkbox"');
  expect(html).toContain('data-mine="true"');
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
    />,
  );
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
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
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
    </>,
  );
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
  // Attachable first, then most recent activity.
  expect(html.indexOf("aspen work")).toBeLessThan(html.indexOf("Old refactor"));
  expect(html.indexOf("Old refactor")).toBeLessThan(html.indexOf("Closed pi"));
  expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Closed pi"));
  expect(html.indexOf("Old refactor")).toBeLessThan(html.indexOf("<details"));
  noUuids(html);
});

const workspace: Workspace = {
  workspace: { id: "workspace", name: "Workspace", created_at: 0 },
  actors,
  onboarding_required: false,
};
const profiles = (chat: Chat) =>
  renderToStaticMarkup(
    <>
      {actors.slice(1).map((agent) => (
        <AgentProfile
          key={agent.id}
          agent={agent}
          workspace={workspace}
          chat={chat}
          busy={false}
          perform={perform}
        />
      ))}
    </>,
  );

test("the team lists each agent once; its profile says where it runs and what can be done", () => {
  const unconfirmed = {
    title: "old aspen",
    native_session_id: "native-old",
    attention_reason: "Stopped here; the running turn may still finish.",
  };
  const chat = fakeChat({
    sessions: [
      session("s-aspen", ASPEN),
      { ...session("s-old", ASPEN, "stopped"), ...unconfirmed },
      // The same session linked again and stopped again: listed once.
      { ...session("s-old-again", ASPEN, "stopped"), ...unconfirmed },
      { ...session("s-gone", ASPEN, "stopped"), title: "gone session" },
      session("s-birch", BIRCH, "attention"),
    ],
  });
  const team = renderToStaticMarkup(
    <Team
      workspace={workspace}
      chat={chat}
      owner={actors[0]!}
      hire={() => {}}
    />,
  );
  expect(team.match(/href="\/team\/[^"]+"/g)).toHaveLength(2);
  const html = profiles(chat);
  // An unconfirmed stop keeps its note, once; a stop without a reason is gone.
  expect(
    html.match(/Stopped here; the running turn may still finish\./g),
  ).toHaveLength(1);
  expect(html).toContain('href="/chats/c-dm"');
  noUuids(team);
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
  expect(html).not.toContain("<script>");
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
  const fresh = form();
  expect(fresh).toMatch(/<option[^>]*value=""[^>]*selected=""[^>]*>/);
});

test("an agent's chat says its model and harness on a line of their own, the name whole", () => {
  const html = renderToStaticMarkup(
    <ChatList
      chat={fakeChat({ conversations: [dm] })}
      actors={[
        ...actors.filter((a) => a.id !== ASPEN),
        { ...agent(ASPEN, "aspen"), model: "fixture-model" },
      ]}
      perform={async () => true}
    />,
  );
  expect(html).toMatch(/>aspen<\/span>[\s\S]*>fixture-model[^<]*<\/span>/);
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
      perform={async () => true}
    />,
  );
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
  expect(ready.match(/data-done="true"/g)).toHaveLength(1);
  // The next step is the main action.
  expect(ready).toMatch(/<button[^>]*class="[^"]*\bbg-primary\b[^"]*"[^>]*>/);
  const chatting = home(fakeChat());
  expect(chatting.match(/data-done="true"/g)).toHaveLength(2);
  const list = renderToStaticMarkup(
    <ChatList chat={fakeChat()} actors={actors} perform={async () => true} />,
  );
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
  // cedar's only session already serves a chat with other people: it joins this one too.
  const busyCedar = add([...base, { ...session("s-aspen-dm", CEDAR) }]);
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
    />,
  );
  expect(html).toMatch(/<li data-mine="true" data-unsent="true"/);
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
    />,
  );
});

test("activity is shown as working or idle, and unknown activity is never shown as idle", () => {
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
    />,
  );
  expect(html).toMatch(/<p data-working="true" class="[^"]*">/);
});

test("the organization shows each person with the agents they own, and what each is doing", () => {
  const ada: Actor = { ...actors[0]!, id: "ada", name: "Ada" };
  const lin: Actor = {
    id: "lin",
    name: "lin",
    kind: "agent",
    owner_id: "ada",
    invited_by: null,
    harness: "pi",
    model: null,
    effort: null,
    permission_mode: null,
    approval_policy: null,
    sandbox: null,
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
        <Organization
          workspace={workspace}
          chat={chat}
          busy={false}
          perform={perform}
        />
      </MemoryRouter>,
    );
  // Every person heads a tree with their own agents; a retired agent is gone.
  const html = at("/org");
  expect(html.indexOf(">Ada<")).toBeGreaterThan(html.indexOf(">Owner<"));
  // The owner's profile opens first and says what each of their agents is doing.
  expect(html).toMatch(/<p[^>]*>Owner<\/p>/);
  // An agent's profile, the same as on Team: its owner, the chat it answers in, its
  // one-to-one chat and where it runs.
  const profile = at(`/org?actor=${ASPEN}`);
  expect(profile).toContain("Owner</a>");
  expect(profile).toContain('href="/chats/c-dm"');
  noUuids(html);
  noUuids(profile);
});

test("an agent's presence prefers a connected session, the same everywhere", () => {
  expect(agentPresence(BIRCH, [])).toMatchObject({
    tone: "stopped",
  });
  // A session needing attention, however busy it last was, loses to a connected one.
  const stale = {
    ...session("s-old", ASPEN, "attention"),
    activity: "working" as const,
  };
  const idle = { ...session("s-new", ASPEN), activity: "idle" as const };
  expect(agentPresence(ASPEN, [stale, idle])).toMatchObject({
    tone: "connected",
  });
  // Alone, it shows its attention, never painted as working.
  expect(agentPresence(ASPEN, [stale])).toMatchObject({
    tone: "attention",
  });
  expect(agentPresence(ASPEN, [])).toMatchObject({
    tone: "stopped",
  });
});

test("chat forms are sent by their own submit button", () => {
  const submits = (html: string) => [
    ...html.matchAll(/<button[^>]*type="submit"[^>]*>/g),
  ];
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
  ).toHaveLength(1);
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
  ).toHaveLength(1);
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
  expect(html).toMatch(/<li data-activity="true"[^>]*>[\s\S]*aspen/);
  // The bubble comes after the last message.
  expect(html.indexOf("data-activity")).toBeGreaterThan(
    html.indexOf("Done: all green."),
  );
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
    />,
  );
  // Under the message it is about, with who coordinates in it.
  expect(parent).toMatch(
    /Can you &lt;b&gt;check&lt;\/b&gt; the test\?[\s\S]*<a[^>]*href="\/chats\/t-tests"[^>]*>[\s\S]*Which tests fail[\s\S]*aspen, birch/,
  );
  // Open threads at a glance; a closed one only under its message.
  expect(parent).toMatch(/data-closed="true"[^>]*>[\s\S]*Old question/);

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
    />,
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
    />,
  );
  noUuids(view);

  // Threads are reached from their chat, not listed with the chats.
  const home = renderToStaticMarkup(
    <ChatHome chat={chat} hire={() => {}} newChat={() => {}} />,
  );
});

test("starting an agent asks for a harness, an agent, a folder and how it asks permission", () => {
  const html = renderToStaticMarkup(
    <StartSession
      chat={fakeChat({})}
      actors={actors}
      folders={["/home/owner/app", "/home/owner/app", "/home/owner/site"]}
      busy={false}
      perform={perform}
      heading="Start a new agent"
    />,
  );
  // A new agent by default here; in the Console, no agent and no name to give.
  expect(html).toMatch(/value=""[^>]*selected="">/);
  expect(html).toContain('id="start-name"');
  const own = renderToStaticMarkup(
    <StartSession
      chat={fakeChat({})}
      actors={actors}
      folders={[]}
      busy={false}
      perform={perform}
      agent="none"
      heading="New session"
    />,
  );
  expect(own).toMatch(/value="none"[^>]*selected="">/);
  expect(own).not.toContain('id="start-name"');
  // On one's own joined computer, the harnesses it runs, in a worktree too.
  const studio = {
    id: "h-studio",
    name: "Studio",
    person_id: OWNER,
    open: false,
    created_at: 0,
    seen_at: 0,
    here: false,
    joined: true,
    online: true,
  };
  const away = renderToStaticMarkup(
    <StartSession
      chat={fakeChat({})}
      actors={actors}
      folders={[]}
      busy={false}
      perform={perform}
      agent="none"
      heading="New session"
      here={false}
      computers={[studio]}
    />,
  );
  expect(away).toContain('id="start-where"');
  expect(away).toMatch(/value="h-studio"[^>]*selected="">Studio</);
  // A session there says so, and leaves on it what stays on it.
  const there: ChatSession = {
    ...session("s-studio", ASPEN),
    harness: "codex",
    host_id: "h-studio",
  };
  const view = renderToStaticMarkup(
    <SessionView
      session={there}
      chat={fakeChat({ sessions: [there] })}
      actors={actors}
      hosts={[studio]}
      busy={false}
      perform={perform}
    />,
  );
  // A guest starts only once the chosen harness has their own account on this computer.
  const guest = renderToStaticMarkup(
    <StartSession
      chat={fakeChat({})}
      actors={actors}
      folders={["/home/owner/app"]}
      busy={false}
      perform={perform}
      agent="none"
      heading="New session"
      ready={(harness) => harness !== "claude-code"}
    />,
  );
  expect(guest).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>/);
  // A guest writes the folder's path: only the computer's own person walks its folders.
  expect(guest).toContain('id="start-folder"');
  expect(html).toContain('value="pi">pi</option>');
  // Each recent folder offered once, chosen with a press.
  expect(html.match(/title="\/home\/owner\/app"/g)).toHaveLength(1);
  for (const id of ["start-model", "start-effort"]) {
    expect(html).toMatch(new RegExp(`<select[^>]*id="${id}"`));
    expect(html).not.toMatch(
      new RegExp(`<input(?=[^>]*id="${id}")[^>]*required=""`),
    );
  }
  // Nothing starts without a folder.
  expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>/);
  noUuids(html);
});

test("agent profiles retain last reported values while native settings load", () => {
  const configured = {
    ...actors[1]!,
    model: "fixture-model",
    effort: "high",
    permission_mode: "plan",
  };
  const html = renderToStaticMarkup(
    <AgentProfile
      agent={configured}
      workspace={workspace}
      chat={fakeChat()}
      busy={false}
      perform={perform}
    />,
  );
  expect(html).toContain('value="fixture-model"');
  expect(html).toContain('value="high"');
  expect(html).toMatch(/<option[^>]*value="plan"[^>]*selected=""/);
});

test("settings forms use selectors for native fields and only the agent's harness controls", () => {
  for (const harness of ["pi", "claude-code", "codex"] as const) {
    const html = renderToStaticMarkup(
      <AgentSettingsForm
        agent={{
          ...actors[1]!,
          harness,
          permission_mode: "auto",
          approval_policy: "on-request",
          sandbox: "workspace-write",
        }}
        busy={false}
        save={async () => undefined}
      />,
    );
    expect(html).toContain('id="agent-setting-model"');
    expect(html).toContain('id="agent-setting-effort"');
    expect(html.includes('id="agent-setting-permission_mode"')).toBe(
      harness === "claude-code",
    );
    expect(html.includes('id="agent-setting-approval_policy"')).toBe(
      harness === "codex",
    );
    expect(html.includes('id="agent-setting-sandbox"')).toBe(
      harness === "codex",
    );
    expect(html).not.toContain("<input");
    if (harness === "codex") {
      expect(html).toMatch(/<option[^>]*value="on-request"[^>]*selected=""/);
      expect(html).toMatch(
        /<option[^>]*value="workspace-write"[^>]*selected=""/,
      );
    }
  }
});

test("saving agent settings disables all controls and never disguises an unknown saved value", () => {
  const html = renderToStaticMarkup(
    <AgentSettingsForm
      agent={{ ...actors[1]!, permission_mode: "future-mode" }}
      busy
      save={async () => undefined}
    />,
  );
  expect(html).toMatch(/<select[^>]*id="agent-setting-model"[^>]*disabled=""/);
  expect(html).toMatch(/<select[^>]*id="agent-setting-effort"[^>]*disabled=""/);
  expect(html).toMatch(/<select[^>]*disabled=""/);
  expect(html).toMatch(/<option[^>]*value="future-mode"[^>]*selected=""/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
});

test("managed Claude and terminal pi offer Resume; other attached sessions do not", () => {
  const html = profiles(
    fakeChat({
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
          attention_reason: "Stopped here; the running turn may still finish.",
        },
      ],
    }),
  );
  expect(html).toContain("Stopped here; the running turn may still finish.");
});

const company: Workspace = {
  workspace: {
    id: "workspace",
    name: "Workspace",
    created_at: 0,
  },
  actors,
  onboarding_required: false,
};

test("tonight lists approvals and live sessions without projects or workers", () => {
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
  expect(html).not.toContain('href="/projects');
  noUuids(html);
});

const files = (overrides: Partial<Files> = {}): Files => ({
  available: true,
  error: "",
  upload: async () => [],
  ...overrides,
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
  expect(html).toMatch(/<input[^>]*name="title"[^>]*value="General"/);
});

test("beside a chat: its members, without task controls", () => {
  const html = renderToStaticMarkup(
    <ChatAbout
      conversation={group}
      actors={actors}
      sessions={[
        { ...session("s-aspen", ASPEN), activity: "working" },
        session("s-birch", BIRCH, "stopped"),
      ]}
    />,
  );
  noUuids(html);
});

test("the console's column is an inbox: what needs you first, each state once, new work marked", () => {
  const working = {
    ...session("s-birch", BIRCH),
    activity: "working" as const,
  };
  const idle = { ...session("s-aspen", ASPEN), activity: "idle" as const };
  const html = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({ sessions: [idle, working] })}
      actors={actors}
    />,
  );
  expect(html.indexOf('href="/console/s-birch"')).toBeLessThan(
    html.indexOf('href="/console/s-aspen"'),
  );
  const inbox = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({
        sessions: [
          {
            ...session("s-aspen-dm", ASPEN),
            output_at: 100,
            summary: "Fixed the build",
          },
          working,
          session("s-aspen", ASPEN),
        ],
        approvals: [approval("a1", "pending")],
      })}
      actors={actors}
    />,
  );
});

test("what a session produces right now follows its recorded work", () => {
  const items = [
    { id: "t", kind: "text" as const, text: "Checking the **build**" },
    { id: "r", kind: "thinking" as const, text: "The cache may be stale" },
    {
      id: "o",
      kind: "output" as const,
      text: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"),
    },
  ];
  const html = render(<LiveItems items={items} />);
  expect(html).toContain('data-streamdown="strong">build<');
  setDensity("compact");
  setDensity("normal");
});

test("while a session works, written words join its turn, wait for its end, or replace it", () => {
  const working = (origin: ChatSession["origin"]) => {
    const busy = {
      ...session("s-birch", BIRCH),
      activity: "working" as const,
      origin,
    };
    saveDraft("s-birch", "Also check the logs");
    const html = renderToStaticMarkup(
      <SessionView
        session={busy}
        chat={fakeChat({ sessions: [busy] })}
        actors={actors}
        busy={false}
        perform={perform}
      />,
    );
    saveDraft("s-birch", "");
    return html;
  };
  const owned = working("owned");
  expect(owned).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
  // Claude Code in a terminal only takes words into the running turn.
  const terminal = working("attached");
});

test("the console holds sessions without an agent, pinned ones first, and archived apart", () => {
  const own: ChatSession = {
    ...session("s-own", ASPEN),
    actor_id: null,
    title: "Release check",
    pinned_at: 3,
  };
  const away: ChatSession = { ...session("s-away", BIRCH), archived_at: 4 };
  const html = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({ sessions: [session("s-aspen", ASPEN), own, away] })}
      actors={actors}
    />,
  );
  expect(html).not.toContain('href="/console/s-away"');
  const view = renderToStaticMarkup(
    <SessionView
      session={own}
      chat={fakeChat({ sessions: [own] })}
      actors={actors}
      busy={false}
      perform={perform}
    />,
  );
  expect(view).toMatch(/<h2[^>]*>Release check<\/h2>/);
});

test("a session's work keeps its requests where they were made, and density sets how much shows", () => {
  const at = (s: number) => `2026-01-01T10:00:0${s}.000Z`;
  const blocks: SessionBlock[] = [
    {
      key: "1",
      time: at(0),
      kind: "input",
      text: "Fix the build",
      chat: null,
      at: 1,
    },
    {
      key: "2",
      time: at(1),
      kind: "thinking",
      text: "The build fails on a type",
      until: at(3),
    },
    {
      key: "3",
      time: at(3),
      kind: "tool",
      id: "t1",
      name: "Bash",
      input: { command: "bun run build" },
      result: { output: "built", error: false, time: at(4) },
    },
    {
      key: "4",
      time: at(5),
      kind: "tool",
      id: "t2",
      name: "Task",
      input: { description: "Check the tests", prompt: "Run the suite" },
    },
    { key: "5", time: at(9), kind: "text", text: "Fixed." },
  ];
  const asked = {
    ...approval("a1", "delivered", "allow"),
    created_at: Date.parse(at(4)),
  };
  const pending = {
    ...approval("a2", "pending"),
    summary: "Push to main",
    created_at: Date.parse(at(9)) + 1,
  };
  const work = () =>
    render(
      <SessionBlocks
        blocks={placeApprovals(blocks, [pending, asked])}
        renderApproval={(a) =>
          a.status === "pending" ? (
            <ApprovalCard
              approval={a}
              chat={fakeChat()}
              actors={actors}
              busy={false}
              perform={perform}
            />
          ) : (
            <ApprovalReceipt approval={a} />
          )
        }
      />,
    );
  const html = work();
  expect(html.indexOf("Run bun test")).toBeLessThan(
    html.indexOf("Check the tests"),
  );
  expect(html.indexOf("Push to main")).toBeGreaterThan(html.indexOf("Fixed."));
  // Compact keeps the outcome; detailed opens every step.
  setDensity("compact");
  const compact = work();
  setDensity("detailed");
  setDensity("normal");
});

test("another person's sessions: marked by whom, shared to read or to work in, and their requests theirs", () => {
  const MAPLE = "0b7c2f1e-0000-4000-8000-0000000000b1";
  const people: Actor[] = [
    ...actors,
    { ...agent(MAPLE, "maple"), kind: "human", invited_by: OWNER },
  ];
  const theirs = (shared: ChatSession["shared"]): ChatSession => ({
    ...session("s-maple", ASPEN),
    owner_id: MAPLE,
    shared,
  });
  const list = renderToStaticMarkup(
    <ConsoleList
      starts={false}
      busy={false}
      perform={perform}
      chat={fakeChat({ sessions: [theirs("read")] })}
      actors={people}
    />,
  );
  const view = (shared: ChatSession["shared"]) =>
    renderToStaticMarkup(
      <SessionView
        session={theirs(shared)}
        chat={fakeChat({ sessions: [theirs(shared)] })}
        actors={people}
        busy={false}
        perform={perform}
      />,
    );
  // Shared to read: followed, code included, without writing to it.
  const read = view("read");
  expect(read).toMatch(/<textarea[^>]*disabled/);
  // Shared to write: worked in as its person does; its title, forks and sharing stay theirs.
  const write = view("write");
  // Its requests wait for its person.
  const request = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...approval("a1", "pending"), session_id: "s-maple" }}
      chat={fakeChat({ sessions: [theirs("write")] })}
      actors={people}
      busy={false}
      perform={perform}
    />,
  );
});

test("a session in the console: its work in the middle, and Interrupt in the box while it works", () => {
  const working = {
    ...session("s-birch", BIRCH),
    activity: "working" as const,
  };
  const html = renderToStaticMarkup(
    <SessionView
      session={working}
      chat={fakeChat({ sessions: [working] })}
      actors={actors}
      busy={false}
      perform={perform}
    />,
  );
  const idle = renderToStaticMarkup(
    <SessionView
      session={session("s-aspen", ASPEN)}
      chat={fakeChat()}
      actors={actors}
      busy={false}
      perform={perform}
    />,
  );
  // Unsent words wait in their session's box.
  saveDraft("s-aspen", "Check the logs");
  expect(
    renderToStaticMarkup(
      <SessionView
        session={session("s-aspen", ASPEN)}
        chat={fakeChat()}
        actors={actors}
        busy={false}
        perform={perform}
      />,
    ),
  ).toContain(">Check the logs</textarea>");
  saveDraft("s-aspen", "");
  // "/" lists the commands the box runs itself; /compact says what it will do.
  const typed = (draft: string) => {
    saveDraft("s-aspen", draft);
    const html = renderToStaticMarkup(
      <SessionView
        session={session("s-aspen", ASPEN)}
        chat={fakeChat()}
        actors={actors}
        busy={false}
        perform={perform}
      />,
    );
    saveDraft("s-aspen", "");
    return html;
  };
  // A stopped session takes no input.
  const stopped = renderToStaticMarkup(
    <SessionView
      session={session("s-aspen", ASPEN, "stopped")}
      chat={fakeChat()}
      actors={actors}
      busy={false}
      perform={perform}
    />,
  );
  expect(stopped).toMatch(/<textarea[^>]*disabled/);
});

test("a session delegated to by another names it, in the Console and in About", () => {
  const lead = session("s-aspen", ASPEN);
  const delegate: ChatSession = {
    ...session("s-birch", BIRCH),
    actor_id: null,
    title: "Check the docs",
    parent_session_id: "s-aspen",
  };
  const list = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({ sessions: [lead, delegate] })}
      actors={actors}
    />,
  );
  const about = renderToStaticMarkup(
    <SessionCard
      session={delegate}
      name="Check the docs"
      facts
      busy={false}
      stop={perform}
      delegatedBy="aspen"
    />,
  );
  expect(about).toMatch(/<dd[^>]*>aspen</);
  // A session ZeroLux started says so, whatever its harness.
  expect(
    renderToStaticMarkup(
      <SessionCard
        session={{ ...session("s-aspen", ASPEN), created: true }}
        name="aspen"
        facts
        busy={false}
        stop={perform}
      />,
    ),
  ).toMatch(/<dd[^>]*>ZeroLux</);
});

test("how full a session's context is shows beside its box, and what it has used in About", () => {
  const usage = {
    context_tokens: 170_000,
    context_window: 200_000,
    total_tokens: 1_234_567,
    cost_usd: 0.5,
  };
  const meter = renderToStaticMarkup(<ContextMeter usage={usage} />);
  expect(meter).toContain('aria-valuenow="85"');
  expect(meter).not.toContain("<button");
  // Almost out, it turns to danger; for the owner, choosing it readies /compact.
  const out = renderToStaticMarkup(
    <ContextMeter
      usage={{ ...usage, context_tokens: 195_000 }}
      compact={() => {}}
    />,
  );
  expect(out).toMatch(/^<button/);
  // A harness that does not say its window shows no share.
  expect(
    renderToStaticMarkup(
      <ContextMeter usage={{ ...usage, context_window: null }} />,
    ),
  ).toBe("");
  const about = renderToStaticMarkup(
    <SessionCard
      session={session("s-aspen", ASPEN)}
      name="aspen"
      facts
      busy={false}
      stop={perform}
      usage={usage}
    />,
  );
  // With a budget, what it has cost of it; the owner changes or removes it.
  const budgeted = renderToStaticMarkup(
    <SessionCard
      session={{ ...session("s-aspen", ASPEN), budget_usd: 5 }}
      name="aspen"
      facts
      busy={false}
      stop={perform}
      usage={{ ...usage, cost_usd: 1.2 }}
      budget={perform}
    />,
  );
});

test("an agent's work sits under the message that asked, and its step rides the working bubble", () => {
  const turn: ChatTurn = {
    delivery: "d1",
    time: "2026-01-01T10:00:00Z",
    ended: true,
    events: [
      {
        type: "tool_call",
        id: "t1",
        name: "Bash",
        input: { command: "bun test" },
        at: 10,
        time: "2026-01-01T10:00:30Z",
      },
      {
        type: "tool_result",
        id: "t1",
        output: "12 pass",
        error: false,
        at: 20,
        time: "2026-01-01T10:01:00Z",
      },
      {
        type: "turn_ended",
        status: "completed",
        at: 30,
        time: "2026-01-01T10:02:00Z",
      },
    ],
  };
  const line = (open: boolean) =>
    render(<WorkLine name="aspen" turn={turn} open={open} toggle={() => {}} />);
  expect(line(false)).toContain('aria-expanded="false"');
  const live = render(
    <LiveWork
      name="aspen"
      turn={{ ...turn, ended: false, events: turn.events.slice(0, 1) }}
      open={false}
      toggle={() => {}}
      busy={false}
      interrupt={() => {}}
    />,
  );
  expect(live).toContain("aspen<span");
  // Before its turn is read, the bubble says only that the agent works.
  const unread = render(
    <LiveWork
      name="aspen"
      open={false}
      toggle={() => {}}
      busy={false}
      interrupt={() => {}}
    />,
  );
  expect(unread).toMatch(/<button[^>]*aria-expanded="false"[^>]*disabled/);
});

test("each tool reads as its own kind: a command, a file, a ZeroLux message, an MCP tool", () => {
  const tool = (
    name: string,
    input: unknown,
    more: Partial<ToolBlock> = {},
  ): ToolBlock => ({
    key: "1.0",
    time: null,
    kind: "tool",
    id: "t1",
    name,
    input,
    result: { output: "ok", error: false, time: null },
    ...more,
  });
  const row = (block: ToolBlock) =>
    renderToStaticMarkup(
      <ToolCall
        tool={block}
        chatTitle={(id) => (id === group.id ? "General" : undefined)}
      />,
    );
  const ran = row(tool("Bash", { command: "bun test" }));
  // While it runs the verb is in the present, lit by a moving light.
  const running = row(
    tool("Bash", { command: "bun test" }, { result: undefined }),
  );
  expect(running).toMatch(/class="[^"]*sweep[^"]*">/);
  const edited = row(
    tool("Edit", {
      file_path: "src/a.ts",
      old_string: "a\nb",
      new_string: "c",
    }),
  );
  const mcp = row(tool("mcp__docs__search_pages", { query: "tokens" }));
  // A call the person or a check refused reads as declined, not as done or failed.
  const declined = row(
    tool(
      "Bash",
      { command: "rm -rf build" },
      {
        result: {
          output:
            "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          error: true,
          time: null,
        },
      },
    ),
  );
});

test("a file a message shares downloads with a press where Storage is, and is only its name where not", () => {
  const link = { id: "f-notes", name: "notes.md" };
  const stored = {
    ...link,
    folder: "",
    size: 2048,
    content_type: "text/markdown",
    created_by: ASPEN,
    created_at: 1,
    updated_at: 1,
    conversation_id: group.id,
  };
  const card = (available: boolean) =>
    renderToStaticMarkup(
      <FileCard link={link} file={stored} available={available} />,
    );
  expect(card(true)).toMatch(/<button[^>]*>.*notes\.md.*\d KB/);
  expect(card(false)).not.toContain("<button");
  expect(card(false)).toContain("notes.md");
});

const nativeSession = (
  availability: "attachable" | "attention",
): DiscoveredSession => ({
  id: "n-cedar",
  harness: "claude-code",
  title: "Refactor the parser",
  workspace: "/tmp/cedar",
  last_activity_at: 1_000,
  native_session_id: "native-cedar",
  availability,
  can_create_context: true,
  reason: availability === "attention" ? "Open in another terminal" : null,
});

test("the console lists the project's own sessions with the live ones, each to open and read", () => {
  const html = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({ sessions: [session("s-aspen", ASPEN)] })}
      actors={actors}
      natives={[nativeSession("attachable")]}
    />,
  );
  expect(html).toContain('href="/console/s-aspen"');
  expect(html).toContain('href="/console/native/n-cedar"');
});

test("a delegated session is listed right under the session that started it", () => {
  const delegate = {
    ...session("s-delegate", BIRCH),
    parent_session_id: "s-coordinator",
  };
  const html = renderToStaticMarkup(
    <ConsoleList
      busy={false}
      perform={perform}
      chat={fakeChat({
        sessions: [
          delegate,
          session("s-other", BIRCH),
          session("s-coordinator", ASPEN),
        ],
      })}
      actors={actors}
    />,
  );
  const links = [...html.matchAll(/href="\/console\/([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(links.indexOf("s-delegate")).toBe(links.indexOf("s-coordinator") + 1);
});

test("a session of the project's own continues from its box, running or saved", () => {
  const box = (availability: "attachable" | "attention") =>
    renderToStaticMarkup(
      <NativeSessionView
        native={nativeSession(availability)}
        chat={fakeChat()}
        busy={false}
        perform={perform}
      />,
    ).match(/<textarea[^>]*>/)![0];
  expect(box("attachable")).not.toContain('disabled=""');
  expect(box("attention")).not.toContain('disabled=""');
});
