import { useEffect, useRef } from "react";
import {
  newProposals,
  noticeText,
  proposer,
  sessionAttentions,
  sessionNotices,
  useExtensions,
} from "@zerolux/chat";
import type { Attention, Chat, ChatSession, Extension } from "@zerolux/chat";
import type { Actor } from "./api";
import { stored } from "./stored";

/** Which notices this device shows: a session needing you or failing, a session finishing. */
export interface NoticeChoice {
  needs: boolean;
  finished: boolean;
}
export const noticeChoice = stored<NoticeChoice>(
  "zerolux-notices",
  { needs: true, finished: true },
  (value): value is NoticeChoice =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as NoticeChoice).needs === "boolean" &&
    typeof (value as NoticeChoice).finished === "boolean",
);

/** The system's notifications, where this page can show them (the desktop app's included). */
export const notifications = () =>
  typeof Notification === "undefined" ? undefined : Notification;

/**
 * Tells you, through the system's notifications, when a session starts needing you, fails or
 * finishes: never about the one you are looking at, and one notification per session at a
 * time. Clicking it opens the session.
 */
export function useSessionNotices(
  chat: Chat,
  actors: Actor[],
  /** The session on screen, if any. */
  looking: string | undefined,
  open: (sessionId: string) => void,
) {
  const attentions = sessionAttentions(chat.sessions, chat.approvals);
  const before = useRef<Record<string, Attention>>(undefined);
  const changed = JSON.stringify(attentions);
  useEffect(() => {
    const was = before.current;
    before.current = attentions;
    const system = notifications();
    if (!was || system?.permission !== "granted") return;
    const choice = noticeChoice.current();
    for (const { id, notice } of sessionNotices(was, attentions)) {
      if (!(notice === "finished" ? choice.finished : choice.needs)) continue;
      const watched =
        id === looking &&
        document.visibilityState === "visible" &&
        document.hasFocus();
      const session = chat.sessions.find((s) => s.id === id);
      if (watched || !session) continue;
      const name =
        actors.find((a) => a.id === session.actor_id)?.name ?? "A session";
      const { title, body } = noticeText(notice, session, chat.approvals, name);
      const shown = new system(title, { body, tag: id });
      shown.onclick = () => {
        window.focus();
        open(id);
        // The desktop app's notifications close on their own.
        shown.close?.();
      };
    }
    // The states decide; the rest is read as it is when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);
}

/**
 * Tells the owner, through the system's notifications, when an agent proposes an extension;
 * clicking it opens the Extensions page.
 */
export function useProposalNotices(
  owns: boolean,
  actors: Actor[],
  sessions: ChatSession[],
  open: () => void,
) {
  const { extensions } = useExtensions(undefined, owns);
  const before = useRef<Extension[]>(undefined);
  useEffect(() => {
    if (!extensions) return;
    const was = before.current;
    before.current = extensions;
    const system = notifications();
    if (system?.permission !== "granted" || !noticeChoice.current().needs)
      return;
    for (const extension of newProposals(was, extensions)) {
      const shown = new system(extension.name, {
        body: `Proposed by ${proposer(extension, actors, sessions)}`,
        tag: `proposal:${extension.id}`,
      });
      shown.onclick = () => {
        window.focus();
        open();
        shown.close?.();
      };
    }
    // The list decides; the rest is read as it is when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);
}
