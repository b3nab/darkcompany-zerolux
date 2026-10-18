import { expect, test } from "bun:test";
import type { Actor } from "./client";
import type { ChatSession } from "./chat";
import {
  inviteLink,
  readInviteLink,
  sessionAccess,
  shareChoice,
  sharedAs,
  whoAmI,
} from "./people";

test("an invite link carries the kernel and the invitation, and is read back", () => {
  const link = inviteLink("http://192.0.2.10:4310/", "a b+c");
  expect(link).toBe("http://192.0.2.10:4310/join?invite=a%20b%2Bc");
  expect(readInviteLink(` ${link} `)).toEqual({
    kernel: "http://192.0.2.10:4310",
    invite: "a b+c",
  });
  expect(
    readInviteLink("https://company.example/join/?ref=chat&invite=t1#top"),
  ).toEqual({ kernel: "https://company.example", invite: "t1" });
  // Anything else is not an invitation.
  expect(readInviteLink("http://192.0.2.10:4310")).toBeUndefined();
  expect(
    readInviteLink("http://192.0.2.10:4310/chat?invite=t1"),
  ).toBeUndefined();
  expect(readInviteLink("ftp://192.0.2.10/join?invite=t1")).toBeUndefined();
});

const actor = (id: string, kind: Actor["kind"]) => ({ id, kind }) as Actor;

test("I am the identity's actor, and the owner only when the kernel says so", () => {
  const actors = [actor("aspen", "human"), actor("birch", "human")];
  const identity = {
    user: { id: "u", name: "Birch", email: "birch@example.test" },
    actor_id: "birch",
    owner: false,
    setup_required: false,
  };
  // Not the first person listed: the one signed in.
  expect(whoAmI(identity, actors, true)).toEqual({
    me: actors[1],
    owner: false,
  });
  expect(whoAmI(null, actors, true)).toEqual({ me: undefined, owner: false });
  // A kernel without sign-in has only its owner.
  expect(whoAmI(null, actors, false)).toEqual({ me: actors[0], owner: true });
});

test("a session is its person's; shared, others read it or work in it", () => {
  const session = (shared: ChatSession["shared"]) =>
    ({ owner_id: "aspen", shared }) as ChatSession;
  expect(sessionAccess(session(null), "aspen")).toEqual({
    mine: true,
    read: true,
    write: true,
  });
  expect(sessionAccess(session(null), "birch")).toEqual({
    mine: false,
    read: false,
    write: false,
  });
  expect(sessionAccess(session("read"), "birch")).toEqual({
    mine: false,
    read: true,
    write: false,
  });
  expect(sessionAccess(session("write"), "birch")).toEqual({
    mine: false,
    read: true,
    write: true,
  });
  expect(shareChoice(null)).toBe("private");
  expect(sharedAs("private")).toBeNull();
  expect(sharedAs("write")).toBe("write");
});
