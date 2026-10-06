import { expect, test } from "bun:test";
import { draftOf, keepDraftsIn, saveDraft } from "./drafts";

test("a chat keeps its unsent text until it is sent or emptied, and a client can keep it", () => {
  const saved: Record<string, string>[] = [];
  keepDraftsIn({ general: "from before", broken: 3 }, (all) => saved.push(all));
  expect(draftOf("general")).toBe("from before");
  expect(draftOf("broken")).toBe("");
  saveDraft("aspen", "half a thought");
  expect(draftOf("aspen")).toBe("half a thought");
  expect(draftOf("general")).toBe("from before");
  // Saved again only when it changes.
  saveDraft("aspen", "half a thought");
  saveDraft("general", "");
  expect(draftOf("general")).toBe("");
  expect(saved).toEqual([
    { general: "from before", aspen: "half a thought" },
    { aspen: "half a thought" },
  ]);
  saveDraft("aspen", "");
});
