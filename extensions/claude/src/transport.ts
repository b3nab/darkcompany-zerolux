import {
  ChatHttpError,
  ChatLinkSuspended,
  type ChatRequest,
} from "@zerolux/bridge";

/** How long a request waits for the kernel to bind the link again after `prepare`. */
const REBIND_WAIT = 60_000;

/**
 * The runner's link to the kernel, swapped in place on a rebind. Paused, a request waits for
 * the next bind; revoked, it fails at once.
 */
export class Transport {
  private current?: ChatRequest;
  private paused?: { done: Promise<void>; resume: () => void };
  private revoked = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly onRevoked: () => void,
    private readonly wait = REBIND_WAIT,
  ) {}

  get bound() {
    return Boolean(this.current) && !this.revoked && !this.paused;
  }
  /** After `pause` or a revocation: only then may another token take over. */
  get rebindable() {
    return this.revoked || Boolean(this.paused);
  }

  request: ChatRequest = async <T>(path: string, body?: unknown) => {
    if (this.paused)
      await Promise.race([
        this.paused.done,
        new Promise((resolve) => setTimeout(resolve, this.wait)),
      ]);
    const current = this.current;
    if (this.revoked) throw new ChatLinkSuspended("ZeroLux revoked this link");
    if (this.paused || !current)
      throw new Error("ZeroLux is unreachable while the link is rebound");
    const call = current<T>(path, body);
    this.inflight.add(call);
    try {
      const result = await call;
      // Revoked while this was in flight: what it allowed (a claim) must not reach the agent.
      if (this.revoked)
        throw new ChatLinkSuspended("ZeroLux revoked this link");
      return result;
    } catch (error) {
      if (error instanceof ChatHttpError && [401, 403].includes(error.status)) {
        // An old token refused after a rebind is no news; the current one means revocation.
        if (current === this.current && !this.revoked) {
          this.revoked = true;
          this.onRevoked();
        }
        // Nothing more reaches the agent, and the bridge keeps its work: only an explicit
        // bind or Stop decides what follows.
        throw new ChatLinkSuspended("ZeroLux revoked this link");
      }
      throw error;
    } finally {
      this.inflight.delete(call);
    }
  };

  /** New requests wait; those in flight end first: after it, the old token is never used. */
  async pause() {
    if (!this.paused) {
      let resume!: () => void;
      const done = new Promise<void>((resolve) => (resume = resolve));
      this.paused = { done, resume };
    }
    await Promise.allSettled([...this.inflight]);
  }

  /** Ends the link for good: waiting and later requests fail at once. */
  close() {
    this.revoked = true;
    const paused = this.paused;
    this.paused = undefined;
    paused?.resume();
  }

  bind(next: ChatRequest) {
    this.current = next;
    this.revoked = false;
    const paused = this.paused;
    this.paused = undefined;
    paused?.resume();
  }
}
