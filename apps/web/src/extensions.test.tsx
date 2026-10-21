import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { actionFields } from "@zerolux/chat";
import type { Extension, ExtensionSetting, JsonSchema } from "@zerolux/chat";
import { ActionForm } from "./ActionForm";
import { ExtensionList, settingChanges, settingsSchema } from "./Extensions";
import { Part } from "./extension-view";
import { uiComponents } from "./native-ui";
import { uiModule } from "@zerolux/ui/host";

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

test("a described view draws its parts; only items with an action run one, none while busy", () => {
  const view = (busy: boolean) =>
    renderToStaticMarkup(
      <Part
        node={{
          type: "stack",
          direction: "column",
          children: [
            { type: "heading", text: "Board" },
            {
              type: "list",
              items: [
                {
                  title: "Plant",
                  action: { name: "done", input: { id: "1" } },
                },
                { title: "Water", badge: "Done" },
              ],
            },
            {
              type: "button",
              title: "Clear",
              tone: "danger",
              confirm: "Clear the board?",
              action: { name: "clear", input: {} },
            },
            { type: "form", action: "add", submit: "Add", values: {} },
          ],
        }}
        run={() => {}}
        busy={busy}
        form={(node) => <form data-action={node.action} />}
      />,
    );
  expect(view(false).match(/<button/g)).toHaveLength(2);
  expect(view(true).match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  // A button that asks first asks only once pressed.
  expect(view(false)).not.toContain("Clear the board?");
  expect(view(false)).toContain('data-action="add"');
});

test("the marketplace offers install or update to the owner, and shows each index it cannot read", () => {
  const offer = {
    index: "https://192.0.2.1/index.json",
    publisher: "aspen",
    description: "",
    version: "1.1.0",
  };
  const html = (owns: boolean) =>
    renderToStaticMarkup(
      <ExtensionList
        extensions={[]}
        marketplace={{
          offers: [
            { ...offer, id: "aspen.notes", name: "Notes", installed: null },
            { ...offer, id: "aspen.clock", name: "Clock", installed: "1.0.0" },
            { ...offer, id: "aspen.maps", name: "Maps", installed: "1.1.0" },
          ],
          errors: [
            { index: "https://192.0.2.2/index.json", error: "Cannot reach it" },
          ],
        }}
        error=""
        owns={owns}
        busy={false}
        perform={async () => true}
      />,
    );
  expect(html(true).match(/>(Install|Update)<\/button>/g)).toEqual([
    ">Install</button>",
    ">Update</button>",
  ]);
  expect(html(true)).toContain("1.0.0 → 1.1.0");
  expect(html(true)).toContain("Cannot reach it");
  expect(html(false)).not.toMatch(/>(Install|Update)<\/button>/);
});

test("the web gives every component a native view uses, and draws only images the view carries", () => {
  expect(() => uiModule(uiComponents)).not.toThrow();
  const Image = uiComponents.Image;
  const image = (src: string) =>
    renderToStaticMarkup(<Image src={src} alt="aspen" />);
  expect(image("data:image/png;base64,AAAA")).toContain("<img");
  expect(image("https://192.0.2.1/aspen.png")).toBe("");
});

test("an extension an agent proposed waits disabled for the owner, by the agent's name", () => {
  const html = renderToStaticMarkup(
    <ExtensionList
      extensions={[
        extension({ enabled: false, running: false, proposed_by: "a-cedar" }),
      ]}
      proposerOf={(one) => (one.proposed_by === "a-cedar" ? "cedar" : "")}
      error=""
      owns
      busy={false}
      perform={async () => true}
    />,
  );
  expect(html).toContain("cedar");
  expect(html.match(/>Enable<\/button>/g)).toHaveLength(1);
  expect(html.match(/>Remove</g)).toHaveLength(1);
});
