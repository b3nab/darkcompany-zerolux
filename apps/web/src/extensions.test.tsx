import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { actionFields } from "@zerolux/chat";
import type { Extension, ExtensionSetting, JsonSchema } from "@zerolux/chat";
import { ActionForm } from "./ActionForm";
import { ExtensionList, settingChanges, settingsSchema } from "./Extensions";

const schema: JsonSchema = {
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string", description: "What the task is" },
    token: { type: "string", format: "password" },
    done: { type: "boolean", default: true },
    state: { enum: ["open", "closed"] },
    tags: { type: "array", items: { enum: ["bug", "idea"] } },
    names: { type: "array", items: { type: "string" } },
    meta: { type: "object", properties: { count: { type: "integer" } } },
    raw: {},
  },
};

const form = (value?: Record<string, unknown>) =>
  renderToStaticMarkup(
    <ActionForm
      schema={schema}
      value={value}
      submit="Create task"
      busy={false}
      run={() => {}}
    />,
  );

test("an action's form draws each field as its kind asks", () => {
  const html = form();
  expect(html).toContain("Title");
  expect(html).toContain("What the task is");
  expect(html).toContain('type="password"');
  expect(html).toContain('<option data-slot="native-select-option"');
  expect(html).toContain(">closed</option>");
  expect(html).toContain('placeholder="One per line"');
  expect(html).toContain('inputMode="numeric"');
  expect(html).toContain("<legend");
  expect(html).toContain(">Meta<");
  expect(html).toContain("font-mono");
  expect(html).toContain(">Create task</button>");
  // Only the required field and the switch go without the "optional" mark.
  expect(html.match(/· optional/g)).toHaveLength(7);
});

test("an action's form starts from an earlier input, else from its defaults", () => {
  const html = form({ tags: ["idea"], title: "Draft" });
  expect(html).toContain('value="Draft"');
  // The default turns the switch on; "idea" is the one tag chosen.
  expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
  expect(html).toMatch(/aria-checked="true"[^]*?>idea</);
});

const extension = (over: Partial<Extension>): Extension => ({
  id: "aspen.tasks",
  name: "Tasks",
  version: "1.0.0",
  publisher: "aspen",
  description: "Tasks for people and agents",
  source: "/home/owner/extensions/tasks",
  dev: false,
  enabled: true,
  running: true,
  error: null,
  dependencies: {},
  parts: ["process"],
  settings: [],
  contributes: {
    actions: [
      {
        name: "create",
        title: "Create task",
        description: "A new task",
        input: schema,
        output: null,
        effects: "write",
      },
    ],
    points: [],
    implements: [],
    events: [],
    subscribes: [],
    triggers: [],
  },
  installed_at: 0,
  updated_at: 0,
  ...over,
});

const list = (extensions: Extension[], owns: boolean) =>
  renderToStaticMarkup(
    <ExtensionList
      extensions={extensions}
      error=""
      owns={owns}
      busy={false}
      perform={async () => true}
    />,
  );

test("everyone sees each extension, whether it runs, and runs its actions", () => {
  const html = list(
    [
      extension({}),
      extension({
        id: "birch.notes",
        name: "Notes",
        enabled: false,
        running: false,
        error: "The process ended",
        dependencies: { "aspen.tasks": ">=1.0" },
      }),
    ],
    false,
  );
  expect(html).toContain("Tasks");
  expect(html).toContain("Running");
  expect(html).toContain("Error");
  expect(html).toContain("The process ended");
  expect(html).toContain("Needs aspen.tasks &gt;=1.0");
  expect(html).toContain("Create task");
  expect(html).toContain("Writes");
  // An action runs only while its extension is enabled.
  expect(html.match(/>Run</g)).toHaveLength(2);
  expect(html.match(/disabled=""[^>]*>Run</g)).toHaveLength(1);
  // Only the owner manages them.
  expect(html).not.toContain(">Disable<");
  expect(html).not.toContain("Load from a folder");
});

test("the owner enables, sets up, loads again and removes them", () => {
  const html = list(
    [
      extension({
        dev: true,
        settings: [
          {
            key: "token",
            type: "secret",
            label: "Token",
            description: "",
            value: null,
            set: true,
          },
        ],
      }),
      extension({ id: "birch.notes", name: "Notes", enabled: false }),
    ],
    true,
  );
  expect(html).toContain(">Disable<");
  expect(html).toContain(">Enable<");
  expect(html).toContain(">Settings<");
  expect(html).toContain("Development");
  expect(html).toContain("/home/owner/extensions/tasks");
  expect(html).toContain(">Load again<");
  // Only a disabled one is removed.
  expect(html.match(/>Remove</g)).toHaveLength(1);
  expect(html).toContain("Load from a folder");
});

test("settings saved: an emptied one is cleared, an empty secret kept", () => {
  const settings: ExtensionSetting[] = [
    {
      key: "url",
      type: "text",
      label: "URL",
      description: "",
      value: "x",
      set: true,
    },
    {
      key: "token",
      type: "secret",
      label: "Token",
      description: "",
      value: null,
      set: true,
    },
    {
      key: "key",
      type: "secret",
      label: "Key",
      description: "",
      value: null,
      set: false,
    },
  ];
  expect(settingChanges(settings, { key: "k-1" })).toEqual({
    url: null,
    key: "k-1",
  });
});

test("a choice setting offers its values by their labels", () => {
  const [field] = actionFields(
    settingsSchema([
      {
        key: "model",
        type: "choice",
        label: "Model",
        description: "",
        value: "fast",
        set: true,
        options: [
          { value: "fast", label: "Fast and small" },
          { value: "best", label: "Slow and accurate" },
        ],
      },
    ]),
  );
  expect(field?.kind).toBe("choice");
  expect(field?.options).toEqual(["Fast and small", "Slow and accurate"]);
});

test("the official extensions not yet installed are offered, installed by the owner", () => {
  const official = [
    {
      id: "zerolux.voice",
      name: "Voice",
      version: "0.1.0",
      publisher: "zerolux",
      description: "Speech to text, and each agent's own voice",
      installed: false,
    },
    {
      id: "zerolux.notes",
      name: "Notes",
      version: "1.2.0",
      publisher: "zerolux",
      description: "Notes",
      installed: true,
    },
  ];
  const html = (owns: boolean) =>
    renderToStaticMarkup(
      <ExtensionList
        extensions={[]}
        official={official}
        error=""
        owns={owns}
        busy={false}
        perform={async () => true}
      />,
    );
  expect(html(true)).toContain("Available");
  expect(html(true)).toContain(
    "Speech to text, and each agent&#x27;s own voice",
  );
  // What is installed is in the list above, not offered again.
  expect(html(true)).not.toContain(">Notes<");
  expect(html(true).match(/>Install</g)).toHaveLength(1);
  expect(html(false)).not.toContain(">Install<");
});
