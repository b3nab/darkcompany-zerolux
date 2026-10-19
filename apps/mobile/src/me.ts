import {
  activeActors,
  requiresSignIn,
  sessionAccess,
  whoAmI,
} from "@zerolux/chat";
import type { ChatSession } from "@zerolux/chat";
import { useAuthentication } from "./auth";
import { useSession } from "./kernel";

/**
 * You, as a person of the workspace, signed in on this phone, and whether you are its owner,
 * who set it up and runs its computer. A kernel without sign-in has only its owner.
 */
export function useMe() {
  const { workspace } = useSession();
  const auth = useAuthentication();
  const actors = activeActors(workspace?.actors ?? []);
  const signIn = auth?.health ? requiresSignIn(auth.health) : true;
  return {
    ...whoAmI(auth?.identity, actors, signIn),
    email: auth?.identity?.user.email,
  };
}

/** What you may do with a session: follow it, work in it, or everything its person does. */
export function useAccess(session: ChatSession | undefined) {
  const { me } = useMe();
  return session
    ? sessionAccess(session, me?.id)
    : { mine: false, read: false, write: false };
}
