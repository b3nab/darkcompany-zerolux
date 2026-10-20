import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations } from "./tracker.ts";

let context: Context | undefined;
let token = "";

const tracker = operations(() => token);
/** Each operation reads the token, which the settings may have changed. */
const fresh =
  <I, O>(operation: (input: I) => Promise<O>) =>
  async (input: I) => {
    if (!context) throw new Error("Not started");
    token = String((await context.secrets()).token ?? "").trim();
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
        name: "clickup",
        title: "ClickUp",
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
