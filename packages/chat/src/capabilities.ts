/** A kernel feature the clients know by its announced name. */
export interface Capability {
  id: string;
  name: string;
}

/** Every feature the clients use, in the order a person reads them. */
export const capabilities: Capability[] = [
  {
    id: "chat-v1",
    name: "Chats",
  },
  {
    id: "byoh-v1",
    name: "Bring your own harness",
  },
  {
    id: "auth-v1",
    name: "Accounts",
  },
  {
    id: "owner-onboarding-v1",
    name: "Onboarding",
  },
  {
    id: "meetings-v1",
    name: "Meetings",
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
    .map((id) => ({ id, name: id, available: true }));
  return [...known, ...unknown];
}
