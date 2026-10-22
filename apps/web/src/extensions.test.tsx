import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { actionFields } from "@zerolux/chat";
import type { Extension, ExtensionSetting, JsonSchema } from "@zerolux/chat";
import { ActionForm } from "./ActionForm";
import { MemoryRouter } from "react-router";
import type { ExtensionCard, MarketplaceOffer } from "@zerolux/chat";
import { ExtensionsHome } from "./Extensions";
import {
  ExtensionPage,
  settingChanges,
  settingsSchema,
} from "./extension-page";
import type { Tab } from "./extension-page";
import { MarketplacePage } from "./marketplace";
import { Part } from "./extension-view";
import { lucideIcon, uiComponents } from "./native-ui";
import { PuzzleIcon } from "lucide-react";
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

const offerOf = (over: Partial<MarketplaceOffer>): MarketplaceOffer => ({
  index: "https://192.0.2.1/index.json",
  id: "aspen.tasks",
  name: "Tasks",
  publisher: "aspen",
  description: "Tasks for people and agents",
  version: "1.1.0",
  installed: null,
  ...over,
});

const home = (
  extensions: Extension[],
  owns: boolean,
  view: "installed" | "proposals" = "installed",
  offers: MarketplaceOffer[] = [],
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ExtensionsHome
        view={view}
        extensions={extensions}
        marketplace={{ offers, marketplaces: [], errors: [] }}
        error=""
        proposerOf={(one) => (one.proposed_by === "a-cedar" ? "cedar" : "")}
        owns={owns}
        busy={false}
        act={() => {}}
        consent={() => {}}
      />
    </MemoryRouter>,
  );

const page = (
  id: string,
  extensions: Extension[],
  owns: boolean,
  tab: Tab = "overview",
  offers: MarketplaceOffer[] = [],
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ExtensionPage
        id={id}
        extensions={extensions}
        marketplace={{ offers, marketplaces: [], errors: [] }}
        owns={owns}
        busy={false}
        perform={async () => true}
        consent={() => {}}
        tab={tab}
      />
    </MemoryRouter>,
  );

test("installed extensions are listed by what they wait for, each opening its page", () => {
  const html = home(
    [
      extension({}),
      extension({
        id: "birch.notes",
        name: "Notes",
        enabled: false,
        running: false,
        error: "The process ended",
      }),
      extension({ id: "cedar.draft", name: "Draft", dev: true }),
    ],
    false,
    "installed",
    [offerOf({ installed: "1.0.0" })],
  );
  expect(html).toContain(">Active");
  expect(html).toContain(">Disabled");
  expect(html).toContain(">In development");
  expect(html).toContain("1 update available");
  expect(html).toContain("1.0.0 → 1.1.0");
  expect(html).toContain("The process ended");
  expect(html).toContain('href="/extensions/birch.notes"');
  // The Marketplace is a page of its own, a button away.
  expect(html).toContain('href="/extensions/marketplace"');
  // Only the owner updates, enables and loads again.
  expect(html).not.toMatch(/>(Update|Enable|Load again)<\/button>/);
  expect(home([extension({ enabled: false })], true)).toContain(
    ">Enable</button>",
  );
});

test("an extension's page shows what it can do, its actions running only while it is enabled", () => {
  const extensions = [
    extension({ dependencies: { "birch.notes": ">=1.0" } }),
    extension({ id: "birch.notes", name: "Notes", enabled: false }),
  ];
  const html = page("aspen.tasks", extensions, false, "access");
  expect(html).toContain("What it contains");
  expect(html).toContain("Create task");
  expect(html).toContain(">write<");
  expect(html).toContain("birch.notes &gt;=1.0");
  expect(html.match(/>Run</g)).toHaveLength(1);
  expect(page("birch.notes", extensions, false, "access")).toMatch(
    /disabled=""[^>]*>Run</,
  );
  // Only the owner acts on it.
  expect(html).not.toContain('aria-label="More"');
  expect(page("birch.notes", extensions, true)).toContain(">Enable</button>");
});

test("an extension's page offers the owner its update, or its install when it is only offered", () => {
  const html = page("aspen.tasks", [extension({})], true, "versions", [
    offerOf({ installed: "1.0.0" }),
  ]);
  expect(html).toContain("Update to 1.1.0");
  expect(html).toContain(">Available<");
  expect(html).toContain(">Installed<");
  const offered = page("aspen.tasks", [], true, "overview", [offerOf({})]);
  expect(offered).toContain(">Install</button>");
  expect(offered).toContain('href="/extensions/marketplace"');
  expect(offered).toContain("192.0.2.1");
  // Settings show only for an installed one that has them.
  expect(offered).not.toContain(">settings<");
});

test("an extension's settings are in its page", () => {
  const html = page(
    "aspen.tasks",
    [
      extension({
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
    ],
    true,
    "settings",
  );
  expect(html).toContain("Token");
  expect(html).toContain(">Save</button>");
  expect(html).toContain("Forget Token");
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
  const html = (owns: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <MarketplacePage
          extensions={[]}
          marketplace={{
            offers: [
              offerOf({ id: "aspen.notes", name: "Notes" }),
              offerOf({ id: "aspen.clock", name: "Clock", installed: "1.0.0" }),
              offerOf({ id: "aspen.maps", name: "Maps", installed: "1.1.0" }),
              offerOf({
                id: "aspen.trail",
                name: "Trail",
                installed: "1.1.0",
                current: false,
              }),
            ],
            marketplaces: [
              { index: "https://192.0.2.1/index.json", name: "Aspen market" },
            ],
            errors: [
              {
                index: "https://192.0.2.2/index.json",
                error: "Cannot reach it",
              },
            ],
          }}
          error=""
          owns={owns}
          consent={() => {}}
        />
      </MemoryRouter>,
    );
  // Updates first, then everything.
  expect(html(true).match(/>(Install|Update)<\/button>/g)).toEqual([
    ">Update</button>",
    ">Update</button>",
    ">Install</button>",
    ">Update</button>",
    ">Update</button>",
  ]);
  expect(html(true)).toContain("1.0.0 → 1.1.0");
  expect(html(true)).toContain("1.1.0 · new build");
  expect(html(true)).toContain(
    "Extensions from 2 marketplaces: Aspen market and 192.0.2.2",
  );
  expect(html(true)).toContain("192.0.2.2: Cannot reach it");
  expect(html(true)).toContain('href="/extensions/marketplaces"');
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

test("an extension an agent proposed waits in Proposals for the owner, by the agent's name", () => {
  const proposed = extension({
    enabled: false,
    running: false,
    proposed_by: "a-cedar",
  });
  const html = home(
    [proposed, extension({ id: "birch.notes", name: "Notes" })],
    true,
    "proposals",
  );
  expect(html).toContain("Proposed by cedar");
  expect(html).toContain(">Review and enable</button>");
  expect(html).toContain(">Remove</button>");
  // It is not among the installed ones until the owner enables it.
  expect(home([proposed], true)).toContain("No extensions.");
});

const cardOf = (over: Partial<ExtensionCard> = {}): ExtensionCard => ({
  summary: "",
  categories: ["knowledge"],
  keywords: ["notes", "markdown"],
  license: "MIT",
  links: { homepage: "https://192.0.2.1/notes", issues: null },
  icon: null,
  icon_dark: null,
  media: [],
  readme: null,
  changelog: null,
  ...over,
});

test("an extension's page shows its card: categories, licence, keywords and links", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ExtensionPage
        id="aspen.notes"
        extensions={[]}
        marketplace={{
          offers: [
            offerOf({ id: "aspen.notes", name: "Notes", card: cardOf() }),
          ],
          marketplaces: [],
          errors: [],
        }}
        owns
        busy={false}
        perform={async () => true}
        consent={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Knowledge");
  expect(html).toContain("MIT");
  expect(html).toContain("markdown");
  expect(html).toMatch(/href="https:\/\/192.0.2.1\/notes"[^>]*>.*Website/);
  expect(html).not.toContain("Report a problem");
});

test("the marketplace counts each category and shows the one chosen", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter
      initialEntries={["/extensions/marketplace?category=knowledge"]}
    >
      <MarketplacePage
        extensions={[]}
        marketplace={{
          offers: [
            offerOf({ id: "aspen.notes", name: "Notes", card: cardOf() }),
            offerOf({
              id: "aspen.drive",
              name: "Drive",
              card: cardOf({ categories: ["files-storage"] }),
            }),
          ],
          marketplaces: [],
          errors: [],
        }}
        error=""
        owns
        consent={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toMatch(/aria-current="true"[^>]*>.*Knowledge.*1</);
  expect(html).toContain(">Notes</h2>");
  expect(html).not.toContain(">Drive</h2>");
});

test("a view's icons are Lucide's by name, renamed ones too; an unknown one is a puzzle", () => {
  expect(lucideIcon("file-text")).not.toBe(PuzzleIcon);
  expect(lucideIcon("file-video")).not.toBe(PuzzleIcon);
  expect(lucideIcon("no-such-icon")).toBe(PuzzleIcon);
});
