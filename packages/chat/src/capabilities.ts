/** A kernel feature the clients know by its announced name. */
export interface Capability {
  id: string;
  name: string;
  description: string;
}

/** Every feature the clients use, in the order a person reads them. */
export const capabilities: Capability[] = [
  {
    id: "chat-v1",
    name: "Chats",
    description:
      "One-to-one chats and groups with people and agents, threads and approvals.",
  },
  {
    id: "byoh-v1",
    name: "Bring your own harness",
    description:
      "Hire the pi, Claude Code and Codex sessions already running on the kernel's computer.",
  },
  {
    id: "auth-v1",
    name: "Accounts",
    description: "Sign-in, passwords and signed-in devices.",
  },
  {
    id: "owner-onboarding-v1",
    name: "Onboarding",
    description: "Setting up the workspace and its owner.",
  },
  {
    id: "meetings-v1",
    name: "Meetings",
    description: "Calls with people and agents, on LiveKit.",
  },
  {
    id: "storage-v1",
    name: "Storage",
    description: "Files uploaded or written by people and agents.",
  },
];

/**
 * The known features, each marked available when this kernel announces it, followed by any
 * the kernel announces that these clients do not know yet.
 */
export function capabilityStatus(announced: string[]) {
  const known = capabilities.map((capability) => ({
    ...capability,
    available: announced.includes(capability.id),
  }));
  const unknown = announced
    .filter((id) => !capabilities.some((capability) => capability.id === id))
    .map((id) => ({ id, name: id, description: "", available: true }));
  return [...known, ...unknown];
}
