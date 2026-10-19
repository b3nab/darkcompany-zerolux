import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonSchema } from "@zerolux/chat";
import { ActionForm } from "./ActionForm";

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
