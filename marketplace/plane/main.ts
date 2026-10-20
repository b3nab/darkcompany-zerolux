import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations, type Plane } from "./tracker.ts";

let context: Context | undefined;
let settings: Plane = { baseUrl: "", workspace: "", key: "" };

const tracker = operations(() => settings);
/** Each operation reads the settings, which may have changed. */
const fresh =
  <I, O>(operation: (input: I) => Promise<O>) =>
  async (input: I) => {
    if (!context) throw new Error("Not started");
    const values = await context.secrets();
    const text = (key: string) => String(values[key] ?? "").trim();
    settings = {
      baseUrl: text("base_url"),
      workspace: text("workspace"),
      key: text("api_key"),
    };
    return operation(input);
  };

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.projects/trackers@1",
        name: "plane",
        title: "Plane",
        operations: {
          projects: fresh(tracker.projects),
          tasks: fresh(tracker.tasks),
          create: fresh(tracker.create),
          update: fresh(tracker.update),
          comment: fresh(tracker.comment),
        },
      },
    ],
  }),
);
