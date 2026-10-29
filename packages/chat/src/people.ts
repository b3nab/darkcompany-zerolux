import { kernelUrl, request } from "./client";
import type { Actor } from "./client";
import type { AuthIdentity } from "./auth";
import type { ChatSession, SessionShare } from "./chat";

/** An invitation the owner made and nobody used yet: its token was shown only when made. */
export interface Invite {
  id: string;
  created_by: string;
  created_at: number;
  expires_at: number;
}

/** A new invitation, valid once for seven days, with the token to send. Only the owner invites. */
export const createInvite = (kernel = kernelUrl()) =>
  request<{ invite: Invite; token: string }>(kernel, "/invites", {});

export const listInvites = (kernel = kernelUrl()) =>
  request<{ invites: Invite[] }>(kernel, "/invites").then(
    ({ invites }) => invites,
  );

export const withdrawInvite = (id: string, kernel = kernelUrl()) =>
  request<unknown>(
    kernel,
    `/invites/${encodeURIComponent(id)}`,
    undefined,
    undefined,
    "DELETE",
  );

/** The link that brings a person in: the kernel's address and the invitation, for every app. */
export const inviteLink = (kernel: string, token: string) =>
  `${kernel.replace(/\/+$/, "")}/join?invite=${encodeURIComponent(token)}`;

/** The kernel and the invitation an invite link carries; nothing when the text is not one. */
export function readInviteLink(text: string) {
  // The kernel's own, or a workspace's on it: `<kernel>/w/<id>/join?invite=…`.
  const link =
    /^(https?:\/\/[^/?#\s]+(?:\/w\/[^/?#\s]+)?)\/join\/?\?(?:[^#\s]*&)?invite=([^&#\s]+)/.exec(
      text.trim(),
    );
  return link
    ? { kernel: link[1]!, invite: decodeURIComponent(link[2]!) }
    : undefined;
}

/**
 * Who is using the app: the person signed in, as an actor of the workspace, and whether they
 * are its owner. A kernel without sign-in has only its owner.
 */
export function whoAmI(
  identity: AuthIdentity | null | undefined,
  actors: Actor[],
  signIn: boolean,
) {
  if (!signIn)
    return { me: actors.find((a) => a.kind === "human"), owner: true };
  return {
    me: actors.find((a) => a.id === identity?.actor_id),
    owner: Boolean(identity?.owner),
  };
}

/**
 * What a person may do with a session. Shared to read, they follow all of it; to write, they
 * work in it as its person does. Its title, organization, budget, sharing, forks and the
 * decisions on its requests stay its person's.
 */
export function sessionAccess(session: ChatSession, me: string | undefined) {
  const mine = session.owner_id === me;
  return {
    mine,
    read: mine || session.shared !== null,
    write: mine || session.shared === "write",
  };
}

/** How a session is shared, as both apps offer it. */
export const shareLabels = {
  private: "Private",
  read: "Read",
  write: "Write",
} as const;
export type ShareChoice = keyof typeof shareLabels;
export const shareChoice = (shared: SessionShare): ShareChoice =>
  shared ?? "private";
export const sharedAs = (choice: ShareChoice): SessionShare =>
  choice === "private" ? null : choice;
