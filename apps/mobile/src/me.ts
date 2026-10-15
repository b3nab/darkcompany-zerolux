import { activeActors } from "@zerolux/chat";
import { useAuthentication } from "./auth";
import { useSession } from "./kernel";

/**
 * You, as a member of the workspace, and whether you own it. The owner is the workspace's
 * first person; a kernel without sign-in has only its owner.
 */
export function useMe() {
  const { workspace } = useSession();
  const auth = useAuthentication();
  const actors = activeActors(workspace?.actors ?? []);
  const owner = actors.find((a) => a.kind === "human");
  const id = auth?.identity ? auth.identity.actor_id : owner?.id;
  return {
    me: actors.find((a) => a.id === id),
    email: auth?.identity?.user.email,
    owner: Boolean(owner && id === owner.id),
  };
}
