import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import {
  newProposals,
  noticeText,
  proposer,
  sessionAttentions,
  sessionName,
  sessionNotices,
  useExtensions,
  isLooking,
} from "@zerolux/chat";
import type { Attention, Extension } from "@zerolux/chat";
import { useMe } from "./me";
import { keptKey, keptName, useKernel, useSession } from "./kernel";
import { preference } from "./saved";

/**
 * Which notices this phone shows: what needs you (a session asking or failing, an agent's
 * proposal), a session finishing.
 */
export interface NoticeChoice {
  needs: boolean;
  finished: boolean;
}
export const noticeChoice = preference<NoticeChoice>(
  "notices",
  { needs: true, finished: true },
  (value): value is NoticeChoice =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as NoticeChoice).needs === "boolean" &&
    typeof (value as NoticeChoice).finished === "boolean",
);

// While the app is open, a session's notice comes down as a banner like any other.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** A notification, by its identifier, gone once you look at what it tells of. */
export const dismissNotice = (id: string) =>
  void Notifications.dismissNotificationAsync(id).catch(() => {});

/**
 * Which workspace a notification is from: said under its title when the phone keeps several,
 * and carried with it, so that a tap opens that workspace first.
 */
function useNoticeWorkspace() {
  const kernel = useKernel();
  // A tap is read as the workspaces are then: one removed since opens nothing.
  const now = useRef(kernel);
  now.current = kernel;
  const here = kernel.current ? keptKey(kernel.current) : undefined;
  return {
    here,
    label:
      kernel.current && kernel.workspaces.length > 1
        ? { subtitle: keptName(kernel.current) }
        : {},
    /** A notification of another workspace opens it, and is read again once it is open. */
    elsewhere(workspace: unknown) {
      if (typeof workspace !== "string" || workspace === here) return false;
      const target = now.current.workspaces.find(
        (w) => keptKey(w) === workspace,
      );
      if (target) void now.current.open(target.kernel, target);
      else Notifications.clearLastNotificationResponse();
      return true;
    },
  };
}

/**
 * Tells you, through the phone's notifications, when a session starts needing you, fails or
 * finishes: never about the one on screen, and one notification per session at a time (the
 * new one takes the old one's place). Tapping it opens the session. Without push, only while
 * the app runs.
 */
export function useSessionNotices() {
  const { workspace, chat } = useSession();
  const from = useNoticeWorkspace();
  const { me } = useMe();
  const pathname = usePathname();
  // Only your sessions: one shared with you needs its person, not you.
  const attentions = sessionAttentions(
    chat.sessions.filter((s) => s.owner_id === me?.id),
    chat.approvals,
  );
  const before = useRef<Record<string, Attention>>(undefined);
  const changed = JSON.stringify(attentions);
  // A session seen further, here or on another of your clients, takes its notification away.
  const seen = useRef<Record<string, number | null | undefined>>(undefined);
  const seenAt = JSON.stringify(
    Object.fromEntries(chat.sessions.map((s) => [s.id, s.seen_at])),
  );
  useEffect(() => {
    const was = seen.current;
    seen.current = JSON.parse(seenAt) as Record<string, number | null>;
    if (!was) return;
    for (const [id, at] of Object.entries(seen.current))
      if (at && at > (was[id] ?? 0)) dismissNotice(id);
  }, [seenAt]);
  useEffect(() => {
    const was = before.current;
    before.current = attentions;
    if (!was) return;
    const choice = noticeChoice.current();
    const notices = sessionNotices(was, attentions).filter(({ id, notice }) => {
      const watched = pathname === `/session/${id}` && isLooking();
      return (
        !watched && (notice === "finished" ? choice.finished : choice.needs)
      );
    });
    if (!notices.length) return;
    void (async () => {
      if (!(await Notifications.getPermissionsAsync()).granted) return;
      for (const { id, notice } of notices) {
        const session = chat.sessions.find((s) => s.id === id);
        if (!session) continue;
        const name = sessionName(session, workspace?.actors ?? []);
        await Notifications.scheduleNotificationAsync({
          identifier: id,
          content: {
            ...noticeText(notice, session, chat.approvals, name),
            ...from.label,
            data: { session: id, workspace: from.here },
            sound: "default",
          },
          trigger: null,
        });
      }
    })();
    // The states decide; the rest is read as it is when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);
  useEffect(() => {
    // Tapping one opens its session or extension, also when the tap launches the app.
    const open = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const { session, extension, workspace } = data ?? {};
      if (from.elsewhere(workspace)) return;
      if (typeof session === "string") router.push(`/session/${session}`);
      else if (typeof extension === "string")
        router.push(`/extensions/proposals/${extension}`);
      else return;
      Notifications.clearLastNotificationResponse();
    };
    open(Notifications.getLastNotificationResponse());
    const tapped = Notifications.addNotificationResponseReceivedListener(open);
    return () => tapped.remove();
  }, []);
}

/**
 * Tells the owner, through the phone's notifications, when an agent proposes an extension,
 * as what needs them: not while its page or the extensions are on screen. Tapping it opens
 * the extension.
 */
export function useProposalNotices() {
  const { url, workspace, chat } = useSession();
  const from = useNoticeWorkspace();
  const { owner } = useMe();
  const pathname = usePathname();
  const { extensions } = useExtensions(url, owner);
  // The last look, on this kernel: another kernel's proposals are no news here.
  const before = useRef<{ url: string; extensions: Extension[] }>(undefined);
  useEffect(() => {
    if (!extensions) return;
    const was = before.current?.url === url ? before.current : undefined;
    before.current = { url, extensions };
    // Not while Extensions is on screen, where they show.
    const watched = isLooking() && pathname.startsWith("/extensions");
    const proposals = watched ? [] : newProposals(was?.extensions, extensions);
    if (!proposals.length || !noticeChoice.current().needs) return;
    void (async () => {
      if (!(await Notifications.getPermissionsAsync()).granted) return;
      for (const extension of proposals)
        await Notifications.scheduleNotificationAsync({
          identifier: `extension:${extension.id}`,
          content: {
            title: extension.name,
            body: `Proposed by ${proposer(extension, workspace?.actors ?? [], chat.sessions)}`,
            ...from.label,
            data: { extension: extension.id, workspace: from.here },
            sound: "default",
          },
          trigger: null,
        });
    })();
    // The extensions decide; the rest is read as it is when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);
}
