import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Subscription } from "@zerolux/chat";
import { TrayPlan, TrayRequest, choicesOf } from "./TrayPanel";
import type { Waiting } from "./TrayPanel";

const asking = (fields: Partial<Approval>): Approval => ({
  id: "r1",
  actor_id: "aspen",
  session_id: "s1",
  conversation_id: null,
  delivery_id: null,
  kind: "permission",
  summary: "Claude Code wants to use Bash",
  details: {},
  status: "pending",
  decision: null,
  scope: null,
  reason: null,
  answer: null,
  native_request_id: "n1",
  created_at: Date.now(),
  ...fields,
});
const waiting = (approval: Approval): Waiting => ({
  workspace: {
    profile: "p1",
    workspace: "w1",
    name: "General",
    kernel: "http://192.0.2.10:4310",
    active: true,
  },
  approval,
  agent: "aspen",
});
const card = (approval: Approval) =>
  renderToStaticMarkup(
    <TrayRequest
      waiting={waiting(approval)}
      focused
      answer={() => {}}
      open={() => {}}
    />,
  );

test("a permission shows what it would run, with the choices its harness offers", () => {
  const permission = asking({
    details: {
      tool: "Bash",
      input: { command: "bun run release && git push --tags" },
      scopes: ["once", "session", "always"],
    },
  });
  const shown = card(permission);
  expect(shown).toContain("bun run release &amp;&amp; git push --tags");
  expect(choicesOf(permission).map((c) => c.id)).toEqual([
    "once",
    "session",
    "always",
    "deny",
  ]);
  // A harness that offers only once: nothing wider can be chosen.
  const once = asking({ details: { tool: "Bash", input: { command: "ls" } } });
  expect(choicesOf(once).map((c) => c.id)).toEqual(["once", "deny"]);
  expect((card(once).match(/<button/g) ?? []).length).toBe(
    (shown.match(/<button/g) ?? []).length - 2,
  );
});

test("a question with one choice among its options is answered with a tap", () => {
  const question = asking({
    kind: "question",
    details: {
      questions: [
        {
          id: "q1",
          question: "Keep the old API?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiple: false,
        },
      ],
    },
  });
  expect(choicesOf(question)).toEqual([
    { id: "answer:0", label: "Yes" },
    { id: "answer:1", label: "No" },
  ]);
  const shown = card(question);
  expect(shown).toContain("Yes");
  expect(shown).toContain("No");
  // Several answers at once open the app instead.
  const many = asking({
    kind: "question",
    details: {
      questions: [
        {
          id: "q1",
          question: "Which?",
          options: [{ label: "A" }],
          multiple: true,
        },
      ],
    },
  });
  expect(choicesOf(many)).toEqual([]);
});

test("a plan shows its main limit until it is opened", () => {
  const now = Date.now();
  const plan: Subscription = {
    id: "claude:owner@example.test",
    provider: "claude",
    plan: "max",
    account: null,
    allowed: true,
    limits: [
      {
        kind: "session",
        group: "session",
        label: null,
        percent: 42,
        resets_at: now + 3_600_000,
        severity: null,
        active: false,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        label: null,
        percent: 61,
        resets_at: now + 86_400_000,
        severity: null,
        active: true,
      },
    ],
    extra_usage: null,
    credits: null,
    resets: null,
    updated_at: now,
    error: null,
  };
  const shown = renderToStaticMarkup(
    <TrayPlan subscription={plan} kernel="http://192.0.2.10:4310" now={now} />,
  );
  expect(shown).toContain("61%");
  expect(shown).not.toContain("42%");
});
