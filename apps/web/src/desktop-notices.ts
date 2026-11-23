import { Channel, invoke } from "@tauri-apps/api/core";
import { setNativeNotices, type NativeNotice } from "@zerolux/chat";

export function useDesktopNotices() {
  setNativeNotices(async (kernel, credential, notice) => {
    const id = crypto.randomUUID();
    const sink = new Channel<NativeNotice>(notice);
    await invoke("notice_subscribe", { kernel, credential, id, sink });
    return () => {
      void invoke("notice_unsubscribe", { id }).catch(() => {});
    };
  });
}
