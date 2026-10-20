import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations } from "./tracker.ts";

let context: Context | undefined;
let key = "";

const tracker = operations(() => key);
/** Each operation reads the key, which the settings may have changed. */
const fresh =
  <I, O>(operation: (input: I) => Promise<O>) =>
  async (input: I) => {
    if (!context) throw new Error("Not started");
    key = String((await context.secrets()).api_key ?? "").trim();
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
        name: "linear",
        title: "Linear",
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
