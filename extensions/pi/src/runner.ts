import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type ChatRequest,
  type Inbox,
  LocalControl,
  chatRequest,
  controlRequest,
  localURL,
  nativeFingerprint,
  readControlDescriptor,
} from "@zerolux/bridge";
import { PiExecutionLease, processExists } from "./execution-lease.ts";
import {
  loadPiProfile,
  savePiProfile,
  type PiExecutionProfile,
} from "./execution-profile.ts";
import {
  checkSavedPi,
  readSavedPi,
  readNewPi,
  validPiState,
  type PiHistorySnapshot,
  type PiInitialState,
  type SavedPiSession,
} from "./saved-session.ts";
import { waitAndExec } from "./exec-gate.ts";
import { newPiSession } from "./new-session.ts";
type Snapshot = PiHistorySnapshot & Partial<PiInitialState>;

export interface PiRunnerConfig {
  nativeSessionId: string;
  workspace: string;
  file: string;
  profile: string;
  /** Fixed by the execution host, never by a chat/API payload. */
  pi: string;
  entry: string;
  /** Set only by the execution host for one explicit creation request. */
  creation?: boolean;
}
export interface PiRunnerDeps {
  connect(base: string, token: string): ChatRequest;
  alive(pid: number): boolean;
  environment(): NodeJS.ProcessEnv;
  persistProfile(profile: PiExecutionProfile): Promise<string>;
}
const defaults: PiRunnerDeps = {
  connect: chatRequest,
  alive: processExists,
  environment: () => process.env,
  persistProfile: savePiProfile,
};

type Child = Bun.Subprocess<"pipe", "pipe", "inherit">;

/** Detached host for ONE stock native pi RPC process. No prompts, no automatic replay/retry. */
export class PiRunner {
  private lease?: PiExecutionLease;
  private profile?: PiExecutionProfile;
  private snapshot?: Snapshot;
  private child?: Child;
  private inputClosed = false;
  private verifiedState?: PiInitialState;
  private controlPath?: string;
  private identity?: { actor: string; company: string; link: string };
  private phase: "waiting" | "starting" | "running" | "stopping" | "ended" =
    "waiting";
  private links = new Set<string>();
  /** The kernel of the link that bound this host: where its native questions go. */
  private kernel?: ChatRequest;
  /** The native extension's own control, where this host asks whose turn it is. */
  private extensionControl?: string;
  /** Questions pi is waiting on, by ID: withdrawn before its input closes on a Stop. */
  private pendingDialogs = new Map<string, () => void>();
  /** The latest native input of the running turn, as this host saw it start on stdout. */
  private lastInput?: string;
  /** Bumped by every event that changes what the turn runs on: a proof is for one value. */
  private inputGeneration = 0;
  private operation?: Promise<Record<string, unknown>>;
  private readonly cancelled = new AbortController();
  private finish!: () => void;
  readonly finished = new Promise<void>((resolve) => (this.finish = resolve));

  constructor(
    readonly config: PiRunnerConfig,
    private readonly deps: PiRunnerDeps = defaults,
  ) {}

  async prepare() {
    this.lease = await PiExecutionLease.acquire(this.config, {
      alive: this.deps.alive,
    });
    try {
      this.profile = await loadPiProfile(
        this.config.profile,
        this.lease.identity,
      );
      if (
        !this.config.creation &&
        !this.lease.previousNativeStopped(this.profile.lastPid) &&
        this.deps.alive(this.profile.lastPid)
      )
        throw new Error(
          "The previously recorded native pi process is still alive",
        );
      this.snapshot = this.config.creation
        ? await readNewPi(
            this.config.file,
            this.config.nativeSessionId,
            this.config.workspace,
          )
        : await readSavedPi(
            this.config.file,
            this.config.nativeSessionId,
            this.config.workspace,
          );
    } catch (error) {
      this.lease.close("exited");
      this.lease = undefined;
      throw error;
    }
  }

  setControl(path: string) {
    this.controlPath = path;
  }

  describe() {
    return {
      kind: "pi-runner",
      guard_version: 1,
      creating: Boolean(this.config.creation && this.phase !== "running"),
      native_session_id: this.config.nativeSessionId,
      workspace: this.config.workspace,
      session_file: this.config.file,
      profile: this.config.profile,
      phase: this.phase,
      native_pid: this.child?.pid,
      model: this.snapshot?.model,
      thinking: this.snapshot?.thinking,
      cli_version: this.profile?.cliVersion,
      link_id: this.identity?.link,
      // This host routes pi's `confirm` dialogs to the owner as approvals.
      dialogs: 1,
    };
  }

  handle(
    method: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "discard_unstarted") {
      const released =
        this.phase === "waiting" && !this.operation && !this.child;
      if (released) this.end();
      return Promise.resolve({ released });
    }
    if (method === "verify") {
      const state = {
        model: request.model as PiInitialState["model"],
        thinking: request.thinking as string,
      };
      if (
        this.phase !== "starting" ||
        request.native_pid !== this.child?.pid ||
        request.session_file !== this.config.file ||
        request.cli_version !== this.profile?.cliVersion ||
        request.auth_configured !== true ||
        !validPiState(state) ||
        (!this.config.creation &&
          (state.model.provider !== this.snapshot?.model?.provider ||
            state.model.id !== this.snapshot?.model?.id ||
            state.thinking !== this.snapshot?.thinking))
      )
        return Promise.reject(
          new Error("The native pi startup guard did not verify its context"),
        );
      this.verifiedState = state;
      return Promise.resolve({});
    }
    if (method === "links") {
      if (
        request.native_pid !== this.child?.pid ||
        !Array.isArray(request.link_ids) ||
        request.link_ids.length > 100 ||
        request.link_ids.some(
          (id) => typeof id !== "string" || !id || id.length > 200,
        ) ||
        (request.control !== undefined &&
          (typeof request.control !== "string" || !isAbsolute(request.control)))
      )
        return Promise.reject(new Error("Invalid native pi link report"));
      this.links = new Set(request.link_ids as string[]);
      this.extensionControl = request.control as string | undefined;
      return Promise.resolve({});
    }
    if (method === "stop") {
      if (
        typeof request.link_id !== "string" ||
        !request.link_id ||
        this.links.size > 1 ||
        (this.child &&
          (this.links.size
            ? !this.links.has(request.link_id)
            : request.link_id !== this.identity?.link))
      )
        return Promise.reject(new Error("Unknown pi runner link"));
      // Stop is not queued behind a blocked startup operation.
      return this.stop().then(() => ({}));
    }
    if (method !== "bind")
      return Promise.reject(new Error("Unknown pi runner operation"));
    if (this.operation)
      return Promise.reject(
        new Error("Pi startup is already in progress; inspect its state"),
      );
    this.operation = this.bind(request).finally(() => {
      this.operation = undefined;
      if (this.phase === "waiting" && !this.child) this.end();
    });
    return this.operation;
  }

  private async wanted(request: ChatRequest): Promise<Inbox> {
    this.cancelled.signal.throwIfAborted();
    const inbox = await request<Inbox>("/chat/inbox");
    this.cancelled.signal.throwIfAborted();
    const { session, workspace } = inbox;
    if (
      session.harness !== "pi" ||
      session.native_session_id !== this.config.nativeSessionId ||
      session.workspace !== this.config.workspace ||
      session.status === "stopped" ||
      !workspace?.id ||
      (this.identity &&
        (session.actor_id !== this.identity.actor ||
          workspace.id !== this.identity.company))
    )
      throw new Error("The token does not name this entrusted pi session");
    // Another link: the kernel closed the previous session's approvals with it, so the
    // questions they carried are withdrawn from pi, never answered or asked again by us.
    if (this.identity && this.identity.link !== session.id) {
      for (const withdraw of this.pendingDialogs.values()) withdraw();
      this.pendingDialogs.clear();
    }
    this.identity = {
      actor: session.actor_id,
      company: workspace.id,
      link: session.id,
    };
    return inbox;
  }

  private async bind(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof input.base_url !== "string" || typeof input.token !== "string")
      throw new Error("Incomplete pi runner bind");
    const request = this.deps.connect(localURL(input.base_url), input.token);
    await this.wanted(request);
    this.kernel = request;
    if (this.phase === "running") return { native_pid: this.child!.pid };
    if (
      this.phase !== "waiting" ||
      !this.lease ||
      !this.profile ||
      !this.snapshot ||
      !this.controlPath
    )
      throw new Error("The pi runner cannot start another native process");
    const profile = this.profile;
    const snapshot = this.snapshot;
    const executable = Bun.which(this.config.pi);
    if (!executable)
      throw new Error(
        "Install pi on this execution host before restoring its sessions",
      );
    this.phase = "starting";
    let touchedProfile = false;
    let execSent = false;
    try {
      // --version exits before opening a session in native pi. Never silently switch the
      // runtime version entrusted by the terminal; no package update is run here.
      await this.checkVersion(executable, profile.cliVersion);
      this.cancelled.signal.throwIfAborted();
      await this.checkSnapshot(snapshot);
      this.cancelled.signal.throwIfAborted();
      const env = Object.fromEntries(
        Object.entries(this.deps.environment()).filter(
          ([key]) => !key.startsWith("ZEROLUX_") && !key.startsWith("PI_"),
        ),
      );
      env.PI_CODING_AGENT_DIR = profile.agentDir;
      if (profile.sessionDir)
        env.PI_CODING_AGENT_SESSION_DIR = profile.sessionDir;
      if (profile.offline !== undefined) env.PI_OFFLINE = profile.offline;
      env.ZEROLUX_PI_RUNNER = this.controlPath;
      const child = Bun.spawn([process.execPath, this.config.entry, "exec"], {
        cwd: snapshot.workspace,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      this.child = child;
      this.lease.setNativeProcess(child.pid);
      const stateId = randomUUID();
      const ready = this.readState(child, stateId, snapshot);
      void ready.catch(() => {}); // It can fail while the final owner-intent read is pending.
      void child.exited.then(async () => {
        // Keep stdout drained even while exiting. Do not release a lease merely because
        // the kernel disappeared or a control exchange timed out.
        await ready.catch(() => {});
        // Startup owns its profile writes until bind settles. Never release the lease
        // early and then overwrite a successor's profile with a late startup result.
        await this.operation?.catch(() => {});
        this.end();
      });
      // Owner Stop observed here prevents exec, even if preflight/version discovery blocked.
      await this.wanted(request);
      await this.checkSnapshot(snapshot);
      touchedProfile = true;
      await this.deps.persistProfile({
        ...profile,
        unavailable:
          "Native pi startup has not confirmed the saved identity/profile; inspect it in native pi before recovery",
      });
      await this.wanted(request);
      this.cancelled.signal.throwIfAborted();
      execSent = true;
      child.stdin.write(
        JSON.stringify({
          exec: executable,
          args: [
            ...profile.args,
            "--session",
            snapshot.file,
            "--mode",
            "rpc",
            ...(this.config.creation
              ? []
              : [
                  "--provider",
                  snapshot.model!.provider,
                  "--model",
                  snapshot.model!.id,
                  "--thinking",
                  snapshot.thinking!,
                ]),
          ],
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ id: stateId, type: "get_state" }) + "\n",
      );
      await child.stdin.flush();
      const state = await ready;
      if (this.config.creation) {
        // Native pi persists model/thinking in this SDK-generated file. A private
        // sidecar must never mask lost/missing native history with a fallback.
        const saved = await readSavedPi(
          this.config.file,
          this.config.nativeSessionId,
          this.config.workspace,
        );
        if (
          saved.model.provider !== state.model.provider ||
          saved.model.id !== state.model.id ||
          saved.thinking !== state.thinking
        )
          throw new Error(
            "Native pi did not persist its confirmed model and thinking",
          );
        this.snapshot = saved;
      }
      this.cancelled.signal.throwIfAborted();
      // Only a verified startup can clear the durable pending/refusal marker. Native
      // extension profile capture must not clear it while this host is still starting.
      await this.deps.persistProfile({
        ...profile,
        lastPid: child.pid,
      });
      this.cancelled.signal.throwIfAborted();
      this.phase = "running";
      return { native_pid: child.pid };
    } catch (error) {
      if (touchedProfile && !execSent) {
        // No native context was opened. Restore only our own pre-exec metadata while
        // still holding the lease; inability to restore leaves a conservative refusal.
        await this.deps.persistProfile(profile).catch(() => {});
      }
      await this.stopNative();
      throw error;
    }
  }

  private async checkSnapshot(snapshot: Snapshot) {
    if (this.config.creation) {
      if (
        JSON.stringify(
          await readNewPi(
            snapshot.file,
            snapshot.nativeSessionId,
            snapshot.workspace,
          ),
        ) !== JSON.stringify(snapshot)
      )
        throw new Error("New pi history changed before native startup");
    } else await checkSavedPi(snapshot as SavedPiSession);
  }

  private async checkVersion(executable: string, expected: string) {
    const child = Bun.spawn([executable, "--version"], {
      cwd: this.config.workspace,
      env: this.deps.environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const reader = child.stdout.getReader();
      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.length > 4096) throw new Error("Invalid pi version metadata");
      }
      if ((await child.exited) !== 0 || text.trim() !== expected)
        throw new Error(
          "The installed pi version changed or could not be verified; no native context was opened",
        );
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }

  private readState(
    child: Child,
    id: string,
    expected: Snapshot,
  ): Promise<PiInitialState> {
    let resolve!: (state: PiInitialState) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<PiInitialState>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Consume all native output for the process lifetime. Never persist/forward native
    // message content, and never leave a full stdout pipe blocking its execution.
    void (async () => {
      let buffer = "",
        discarding = false,
        confirmed = false;
      const decoder = new TextDecoder();
      try {
        const reader = child.stdout.getReader();
        while (true) {
          const { value: bytes, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(bytes, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (discarding) {
              discarding = false;
              continue;
            }
            let event: Record<string, any>;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.type === "extension_ui_request") {
              void this.dialog(child, event);
              continue;
            }
            // Which input the turn runs on, as this host sees it: pi's own events, no content.
            if (
              ["agent_start", "agent_end", "agent_settled"].includes(event.type)
            ) {
              this.lastInput = undefined;
              this.inputGeneration++;
            } else if (
              event.type === "message_start" &&
              ["user", "custom", "bashExecution"].includes(event.message?.role)
            ) {
              this.lastInput =
                event.message.role === "bashExecution"
                  ? undefined
                  : nativeFingerprint(event.message);
              this.inputGeneration++;
            }
            if (confirmed) continue;
            if (event.type !== "response" || event.id !== id) continue;
            const state = event.data;
            const confirmedState = {
              model: { provider: state?.model?.provider, id: state?.model?.id },
              thinking: state?.thinkingLevel,
            };
            if (
              !event.success ||
              state?.sessionId !== expected.nativeSessionId ||
              state?.sessionFile !== expected.file ||
              !validPiState(confirmedState) ||
              JSON.stringify(confirmedState) !==
                JSON.stringify(this.verifiedState) ||
              (!this.config.creation &&
                (state?.model?.provider !== expected.model?.provider ||
                  state?.model?.id !== expected.model?.id ||
                  state?.thinkingLevel !== expected.thinking))
            ) {
              // The durable pre-exec marker already prevents a later attempt from
              // treating this startup's changed metadata as a newly selected profile.
              confirmed = true; // Continue draining native output during orderly shutdown.
              reject(
                new Error(
                  "Native pi did not confirm the saved identity and profile",
                ),
              );
              continue;
            }
            confirmed = true;
            resolve(confirmedState);
          }
          if (buffer.length > 1024 * 1024) {
            buffer = "";
            discarding = true;
          }
        }
        if (!confirmed)
          reject(
            new Error("Native pi exited without confirming its saved context"),
          );
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Native pi RPC failed"),
        );
      }
    })();
    return ready;
  }

  /**
   * The delivery of this host's link that the native turn is for, or null. `input` is what
   * this host had seen the turn take when pi asked; the extension's answer must be about
   * that very input, and nothing may have changed meanwhile: otherwise nothing is routed.
   */
  private async turnDelivery(
    child: Child,
    input: { fingerprint: string | undefined; generation: number },
  ): Promise<string | null> {
    if (!this.extensionControl || !this.identity || !input.fingerprint)
      return null;
    try {
      const descriptor = await readControlDescriptor(this.extensionControl);
      if (descriptor.pid !== child.pid) return null;
      const turn = await controlRequest(descriptor, "turn", {
        native_session_id: this.config.nativeSessionId,
        workspace: this.config.workspace,
      });
      return typeof turn.delivery === "string" &&
        turn.delivery &&
        turn.link_id === this.identity.link &&
        turn.fingerprint === input.fingerprint &&
        this.inputGeneration === input.generation
        ? turn.delivery
        : null;
    } catch {
      return null;
    }
  }

  /**
   * A question pi asks its user, who is not at a terminal here. A yes/no question in a turn
   * that one chat feeds goes to the owner as an approval of that chat's delivery, through
   * the kernel of the link that bound this host; the answer comes back as pi's own
   * response, once. Anything else is reported, never answered on the owner's behalf. A Stop
   * withdraws the question; pi's own timeout ends it, and a decision after that is not
   * replayed.
   */
  private async dialog(child: Child, event: Record<string, any>) {
    const id = event.id;
    if (typeof id !== "string" || !id) return;
    const fire = [
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
    ];
    if (fire.includes(event.method)) return;
    // What the turn ran on when pi asked: a proof must be about exactly this.
    const input = {
      fingerprint: this.lastInput,
      generation: this.inputGeneration,
    };
    const deadline =
      typeof event.timeout === "number" && event.timeout > 0
        ? Date.now() + event.timeout
        : undefined;
    const respond = (body: Record<string, unknown>) => {
      if (this.inputClosed || child.exitCode !== null) return;
      child.stdin.write(
        JSON.stringify({ type: "extension_ui_response", id, ...body }) + "\n",
      );
      void child.stdin.flush();
    };
    // From here a Stop withdraws the question, whatever stage it is at.
    this.pendingDialogs.set(id, () => respond({ cancelled: true }));
    const stopped = () =>
      this.cancelled.signal.aborted || !this.pendingDialogs.has(id);
    const resolveApproval = (approval: string) =>
      this.kernel?.(`/chat/approvals/${approval}/receipt`, {
        status: "resolved",
      }).catch(() => {});
    try {
      if (!this.kernel || this.phase !== "running") return;
      const delivery =
        event.method === "confirm"
          ? await this.turnDelivery(child, input)
          : null;
      if (stopped()) return;
      if (event.method !== "confirm" || !delivery) {
        await this.kernel(
          `/chat/sessions/${encodeURIComponent(this.identity!.link)}/status`,
          {
            status: "attention",
            reason:
              event.method === "confirm"
                ? "pi asks for a confirmation in a turn that is private or shared between chats; it waits for its own timeout."
                : "pi asks for native input this host cannot represent (a choice or text); it waits for its own timeout.",
          },
        ).catch(() => {});
        // Unanswered on the owner's behalf; still withdrawn by a Stop until pi's own
        // timeout, if it has one, has ended it.
        if (deadline !== undefined)
          setTimeout(
            () => this.pendingDialogs.delete(id),
            Math.max(0, deadline - Date.now()),
          ).unref();
        return;
      }
      const approval = randomUUID();
      try {
        await this.kernel("/chat/approvals", {
          id: approval,
          delivery_id: delivery,
          native_request_id: `pi-ui:${id}`,
          summary: "pi asks for your confirmation",
          details: {
            method: "confirm",
            title: typeof event.title === "string" ? event.title : "",
            message: typeof event.message === "string" ? event.message : "",
          },
        });
      } catch {
        return; // Not recorded: pi's own timeout decides, nothing is answered for the owner.
      }
      // The decision arrives with the inbox, through whichever kernel link is bound now.
      while (!stopped() && child.exitCode === null) {
        if (deadline !== undefined && Date.now() >= deadline) {
          // pi answered itself by now: the question is over, the approval closes, and a
          // later decision is never replayed into pi.
          this.pendingDialogs.delete(id);
          await resolveApproval(approval);
          return;
        }
        await Bun.sleep(500);
        const kernel = this.kernel;
        if (!kernel) continue;
        const inbox = await kernel<{
          approvals?: {
            id: string;
            status: string;
            decision?: string | null;
          }[];
        }>("/chat/inbox").catch(() => undefined);
        const current = inbox?.approvals?.find((a) => a.id === approval);
        if (!current) continue;
        if (current.status === "decided") {
          if (stopped()) break;
          const dispatched = await kernel(
            `/chat/approvals/${approval}/dispatch`,
            {},
          ).then(
            () => true,
            () => false,
          );
          if (!dispatched) continue;
          // Dispatched: the decision is spent either way. Only an open question gets it.
          if (this.pendingDialogs.delete(id))
            respond({ confirmed: current.decision === "allow" });
          await resolveApproval(approval);
          return;
        }
        if (current.status === "resolved") {
          if (this.pendingDialogs.delete(id)) respond({ cancelled: true });
          return;
        }
      }
      // Stopped (withdrawn by the Stop), or pi went away: not decided.
      this.pendingDialogs.delete(id);
      await resolveApproval(approval);
    } catch {
      this.pendingDialogs.delete(id);
    }
  }

  private end() {
    this.phase = "ended";
    this.lease?.close("exited");
    this.lease = undefined;
    this.finish();
  }

  private cancelNative() {
    this.cancelled.abort(
      new Error("The pi execution was stopped before startup completed"),
    );
    if (this.phase !== "ended") this.phase = "stopping";
    if (this.child) {
      if (!this.inputClosed) {
        for (const withdraw of this.pendingDialogs.values()) withdraw();
        this.pendingDialogs.clear();
        this.inputClosed = true;
        this.child.stdin.end();
      }
    }
  }

  private async stopNative() {
    this.cancelNative();
    // No force-kill or timeout-based claim that native execution died.
    await this.child?.exited;
    this.end();
  }

  async stop() {
    this.cancelNative(); // Interrupt native startup before waiting for its completion.
    await this.operation?.catch(() => {});
    await this.stopNative();
  }
}

async function main() {
  if (process.argv[2] === "exec") {
    waitAndExec();
    return;
  }
  const raw = process.env.ZEROLUX_PI_CONFIG;
  if (!raw) throw new Error("Pi runner configuration is missing");
  let config = JSON.parse(raw) as PiRunnerConfig;
  const registry = process.env.ZEROLUX_PI_REGISTRY;
  if (!registry) throw new Error("Pi runner registry is missing");
  config.workspace = await realpath(config.workspace);
  config.entry = Bun.main;
  if (config.creation)
    config = await newPiSession(config.workspace, config.entry, config.pi);
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const runner = new PiRunner(config);
  await runner.prepare();
  const control = new LocalControl(
    registry,
    {
      describe: () => runner.describe(),
      handle: (method, request) => runner.handle(method, request),
    },
    "pi-runner",
  );
  try {
    await control.start();
    runner.setControl(join(registry, `${control.instanceId}.json`));
    await runner.finished;
  } finally {
    await control.close();
    await runner.stop();
  }
}

if (import.meta.main) await main();
