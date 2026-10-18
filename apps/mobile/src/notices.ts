import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import {
  noticeText,
  sessionAttentions,
  sessionName,
  sessionNotices,
} from "@zerolux/chat";
import type { Attention } from "@zerolux/chat";
import { useSession } from "./kernel";
import { preference } from "./saved";

/** Which notices this phone shows: a session needing you or failing, a session finishing. */
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

/** A session's notification, gone once you look at the session. */
export const dismissNotice = (sessionId: string) =>
  void Notifications.dismissNotificationAsync(sessionId).catch(() => {});

/**
 * Tells you, through the phone's notifications, when a session starts needing you, fails or
 * finishes: never about the one on screen, and one notification per session at a time (the
 * new one takes the old one's place). Tapping it opens the session. Without push, only while
 * the app runs.
 */
export function useSessionNotices() {
  const { workspace, chat } = useSession();
  const pathname = usePathname();
  const attentions = sessionAttentions(chat.sessions, chat.approvals);
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
    // Tapping one opens its session, also when the tap launches the app.
    const open = (response: Notifications.NotificationResponse | null) => {
      const id = response?.notification.request.content.data?.session;
      if (typeof id !== "string") return;
      router.push(`/session/${id}`);
      Notifications.clearLastNotificationResponse();
    };
    open(Notifications.getLastNotificationResponse());
    const tapped = Notifications.addNotificationResponseReceivedListener(open);
    return () => tapped.remove();
  }, []);
}
