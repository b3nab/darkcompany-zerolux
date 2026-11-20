import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeMetadata } from "./managed.ts";

/** A terminal pi hands its session to ZeroLux when it is at rest, with nothing half written. */
export function checkTerminalTakeover(
  ctx: ExtensionContext,
  metadata: NativeMetadata,
) {
  if (
    ctx.mode !== "tui" ||
    metadata.runner ||
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    ctx.ui.getEditorText() !== "" ||
    !metadata.session_file
  )
    throw new Error("Takeover needs a terminal pi at rest");
}
