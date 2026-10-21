import { useEffect, useRef } from "react";
import { AppState } from "react-native";
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
} from "@zerolux/chat";
import type { Attention, Extension } from "@zerolux/chat";
import { useMe } from "./me";
import { useSession } from "./kernel";
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
 * Tells you, through the phone's notifications, when a session starts needing you, fails or
 * finishes: never about the one on screen, and one notification per session at a time (the
 * new one takes the old one's place). Tapping it opens the session. Without push, only while
 * the app runs.
 */
export function useSessionNotices() {
  const { workspace, chat } = useSession();
  const { me } = useMe();
  const pathname = usePathname();
  // Only your sessions: one shared with you needs its person, not you.
  const attentions = sessionAttentions(
    chat.sessions.filter((s) => s.owner_id === me?.id),
    chat.approvals,
  );
  const before = useRef<Record<string, Attention>>(undefined);
  const changed = JSON.stringify(attentions);
  useEffect(() => {
    const was = before.current;
    before.current = attentions;
    if (!was) return;
    const choice = noticeChoice.current();
    const notices = sessionNotices(was, attentions).filter(({ id, notice }) => {
      const watched =
        pathname === `/session/${id}` && AppState.currentState === "active";
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
            data: { session: id },
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
      const { session, extension } = data ?? {};
      if (typeof session === "string") router.push(`/session/${session}`);
      else if (typeof extension === "string")
        router.push(`/extension/${extension}`);
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
  const { owner } = useMe();
  const pathname = usePathname();
  const { extensions } = useExtensions(url, owner);
  // The last look, on this kernel: another kernel's proposals are no news here.
  const before = useRef<{ url: string; extensions: Extension[] }>(undefined);
  useEffect(() => {
    if (!extensions) return;
    const was = before.current?.url === url ? before.current : undefined;
    before.current = { url, extensions };
    const proposals = newProposals(was?.extensions, extensions).filter(
      (e) =>
        AppState.currentState !== "active" ||
        (pathname !== "/extensions" && pathname !== `/extension/${e.id}`),
    );
    if (!proposals.length || !noticeChoice.current().needs) return;
    void (async () => {
      if (!(await Notifications.getPermissionsAsync()).granted) return;
      for (const extension of proposals)
        await Notifications.scheduleNotificationAsync({
          identifier: `extension:${extension.id}`,
          content: {
            title: extension.name,
            body: `Proposed by ${proposer(extension, workspace?.actors ?? [], chat.sessions)}`,
            data: { extension: extension.id },
            sound: "default",
          },
          trigger: null,
        });
    })();
    // The extensions decide; the rest is read as it is when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);
}
