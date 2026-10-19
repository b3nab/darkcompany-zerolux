// Keep the pi entrypoint for existing hosts/tests; both harnesses use the same gate.
import { waitAndExec } from "@zerolux/bridge/exec-gate";
export { waitAndExec };

if (import.meta.main) waitAndExec();
