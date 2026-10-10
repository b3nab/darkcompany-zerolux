import { expect, test } from "bun:test";
import { ChatHttpError, ChatLinkSuspended, Transport } from "./index.ts";

test("revocation suspends native transport until a verified bind, without retrying requests", async () => {
  let calls = 0,
    revocations = 0;
  const transport = new Transport(() => {
    revocations++;
  });
  transport.bind(async () => {
    calls++;
    throw new ChatHttpError(401);
  });
  await expect(transport.request("/chat/inbox")).rejects.toBeInstanceOf(
    ChatLinkSuspended,
  );
  await expect(transport.request("/chat/inbox")).rejects.toBeInstanceOf(
    ChatLinkSuspended,
  );
  expect(calls).toBe(1);
  expect(revocations).toBe(1);
  expect(transport.rebindable).toBe(true);
  transport.bind(async <T>() => ({ restored: true }) as T);
  expect(await transport.request<{ restored: boolean }>("/chat/inbox")).toEqual(
    { restored: true },
  );
});

test("a conversation permission refusal is final for that message, not a revoked native link", async () => {
  let revocations = 0;
  const transport = new Transport(() => {
    revocations++;
  });
  transport.bind(async <T>(path: string) => {
    if (path.startsWith("/conversations/")) throw new ChatHttpError(403);
    return { connected: true } as T;
  });
  await expect(
    transport.request("/conversations/not-allowed/messages", {}),
  ).rejects.toBeInstanceOf(ChatHttpError);
  expect(
    await transport.request<{ connected: boolean }>("/chat/inbox"),
  ).toEqual({ connected: true });
  expect(transport.bound).toBe(true);
  expect(revocations).toBe(0);
});
