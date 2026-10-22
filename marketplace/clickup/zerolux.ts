/**
 * The SDK of ZeroLux extensions' process parts, in TypeScript. An extension describes its
 * actions, the extension points it opens and those of others it implements, the events it
 * publishes and hears, and its triggers; `serve` runs it as the kernel starts it, talking
 * JSON-RPC 2.0 over standard input and output.
 */

/** A JSON Schema. */
export type Schema = Record<string, unknown>;

/** Who runs an action: a person, an agent's session, another extension or a trigger. */
export interface Caller {
  actor_id: string | null;
  session_id: string | null;
  by: string | null;
  /** The kernel's address as the person's device reached it, for a sign-in to come back to. */
  origin?: string;
}

/** What an extension can ask the kernel, and what it knows of itself. */
export interface Context {
  extension: { id: string; version: string };
  /** Its own folder, for its files: private to it and the kernel, removed with it. */
  folder: string;
  /** The workspace's storage area: the files its people and agents keep. */
  storageArea: string;
  /** Its settings, without secrets; kept current as they change. */
  settings: Record<string, unknown>;
  /** Its settings with its secrets, read from the kernel when needed. */
  secrets(): Promise<Record<string, unknown>>;
  /** Values it keeps in the workspace, by key. */
  values: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /**
   * Secrets it keeps itself, as many as it needs (one for each account, say): encrypted with
   * the kernel's key and never shown to people's clients.
   */
  vault: {
    get<T = unknown>(name: string): Promise<T | undefined>;
    set(name: string, value: unknown): Promise<void>;
    delete(name: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /**
   * Signing in to another service with OAuth (authorization code with PKCE). `start` gives the
   * address the person opens; the service comes back to the kernel, which keeps the tokens in
   * the secret named and tells the extension with its `zerolux/signed_in` event,
   * `{secret, ok, error?}`. `token` gives a valid access token from that secret, renewed when
   * due.
   */
  oauth: {
    start(request: SignIn): Promise<{ url: string; redirect_uri: string }>;
    token(secret: string): Promise<{
      access_token: string;
      token_type: string;
      expires_at: number | null;
      scope: string | null;
    }>;
  };
  /** The workspace's name, and its people and agents. */
  workspace(): Promise<{
    name: string;
    actors: { id: string; name: string; kind: "person" | "agent" }[];
  }>;
  /** Publishes one of its events, named under it. */
  publish(event: string, payload?: unknown): Promise<void>;
  /** Runs another extension's action. */
  run<T = unknown>(
    extension: string,
    action: string,
    input?: unknown,
  ): Promise<T>;
  points: {
    implementations(
      point: string,
    ): Promise<{ extension: string; name: string; title: string }[]>;
    call<T = unknown>(
      point: string,
      implementation: string,
      operation: string,
      input?: unknown,
    ): Promise<T>;
  };
  /** A new tree for one of its `remote` views, shown with `context`. */
  updateView(name: string, context: unknown, tree: unknown): Promise<void>;
  /**
   * An agent hears `text` in its newest running session, as input that waits for its turn:
   * that session's id. Refused when the agent has none running.
   */
  tellAgent(actorId: string, text: string): Promise<string>;
  log(message: string): void;
}

/** A sign-in to another service. */
export interface SignIn {
  /** The secret the tokens are kept in. */
  secret: string;
  authorize_url: string;
  token_url: string;
  client_id: string;
  client_secret?: string;
  scopes?: string[];
  /** More of the service's own parameters, such as `access_type: "offline"`. */
  params?: Record<string, string>;
  /** The caller's `origin`, so that the service sends the person back to the kernel they reached. */
  origin?: string;
}

export interface Action<I = any, O = unknown> {
  title: string;
  description: string;
  input?: Schema;
  output?: Schema;
  effects?: "read" | "write" | "destructive";
  /** How long it may take, in seconds, when longer than a minute (up to 30 minutes). */
  seconds?: number;
  run(input: I, context: Context & { caller: Caller }): O | Promise<O>;
}

/** An extension point it opens: the contract its implementations follow. */
export interface Point {
  version: number;
  description?: string;
  operations: Record<
    string,
    { description?: string; input?: Schema; output?: Schema }
  >;
}

/** Its implementation of another extension's point. */
export interface Implementation {
  /** `publisher.extension/point@version`. */
  point: string;
  name: string;
  title: string;
  operations: Record<
    string,
    (input: any, context: Context) => unknown | Promise<unknown>
  >;
}

/** A piece of its interface in one of the clients' spaces. */
export interface UiPiece {
  space: "page" | "session" | "chat" | "message" | "settings";
  name: string;
  title: string;
  /** The name of one of the clients' icons. */
  icon?: string;
  view:
    | { kind: "native"; entry?: string }
    | { kind: "described"; action: string; refresh_on?: string[] }
    | { kind: "remote"; action: string }
    | { kind: "web"; entry: string }
    | { kind: "action"; action: string };
}

export interface Extension {
  actions?: Record<string, Action>;
  points?: Record<string, Point>;
  implements?: Implementation[];
  /** Events it publishes. */
  events?: Record<string, { description?: string }>;
  /** Events it hears, `publisher.extension/event`, and what it does then. */
  on?: Record<
    string,
    (payload: unknown, context: Context) => void | Promise<void>
  >;
  /** When `event:<publisher.extension/event>` or `schedule:<cron>`, run one of its actions. */
  triggers?: { on: string; action: string }[];
  /** What it shows in the clients, and where. */
  ui?: UiPiece[];
  /** Once the kernel has started it. */
  start?(context: Context): void | Promise<void>;
  /** After its settings changed. */
  settingsChanged?(context: Context): void | Promise<void>;
}

export function defineExtension(extension: Extension): Extension {
  return extension;
}

/** What it brings, as the kernel reads it when enabling it. */
export function contributes(extension: Extension) {
  return {
    actions: Object.entries(extension.actions ?? {}).map(([name, action]) => ({
      name,
      title: action.title,
      description: action.description,
      input: action.input ?? { type: "object" },
      ...(action.output ? { output: action.output } : {}),
      effects: action.effects ?? "read",
      ...(action.seconds ? { seconds: action.seconds } : {}),
    })),
    points: Object.entries(extension.points ?? {}).map(([name, point]) => ({
      name,
      version: point.version,
      description: point.description ?? "",
      operations: Object.entries(point.operations).map(([name, operation]) => ({
        name,
        description: operation.description ?? "",
        input: operation.input ?? { type: "object" },
        ...(operation.output ? { output: operation.output } : {}),
      })),
    })),
    implements: (extension.implements ?? []).map(({ point, name, title }) => ({
      point,
      name,
      title,
    })),
    events: Object.entries(extension.events ?? {}).map(([name, event]) => ({
      name,
      description: event.description ?? "",
    })),
    subscribes: Object.keys(extension.on ?? {}),
    triggers: extension.triggers ?? [],
    ui: extension.ui ?? [],
  };
}

interface Message {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
}

/** The lines of a stream, one at a time. */
async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
    }
  }
  if (buffered.trim()) yield buffered;
}

/**
 * Runs the extension as the kernel's process part. `input` and `write` default to the
 * process's standard input and output; tests pass their own.
 */
export async function serve(
  extension: Extension,
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Promise<void> {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const send = (message: Message) =>
    write(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const ask = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const context: Context = {
    extension: { id: "", version: "" },
    folder: "",
    storageArea: "",
    settings: {},
    secrets: async () => (await ask("settings.get")).settings,
    values: {
      get: async (key) => (await ask("values.get", { key })).value ?? undefined,
      set: async (key, value) => void (await ask("values.set", { key, value })),
      delete: async (key) =>
        void (await ask("values.set", { key, value: null })),
      list: async (prefix = "") => (await ask("values.list", { prefix })).keys,
    },
    vault: {
      get: async (name) =>
        (await ask("secrets.get", { name })).value ?? undefined,
      set: async (name, value) =>
        void (await ask("secrets.set", { name, value })),
      delete: async (name) =>
        void (await ask("secrets.set", { name, value: null })),
      list: async (prefix = "") =>
        (await ask("secrets.list", { prefix })).names,
    },
    oauth: {
      start: async (request) => ask("oauth.start", request),
      token: async (secret) => ask("oauth.token", { secret }),
    },
    workspace: async () => ask("workspace.actors"),
    publish: async (name, payload) =>
      void (await ask("events.publish", { name, payload: payload ?? null })),
    run: async (extensionId, action, input) =>
      (
        await ask("actions.run", {
          extension: extensionId,
          action,
          input: input ?? {},
        })
      ).result,
    points: {
      implementations: async (point) =>
        (await ask("points.implementations", { point })).implementations,
      call: async (point, implementation, operation, input) =>
        (
          await ask("points.call", {
            point,
            implementation,
            operation,
            input: input ?? {},
          })
        ).result,
    },
    tellAgent: async (actorId, text) =>
      (await ask("agents.tell", { actor_id: actorId, text })).session_id,
    updateView: async (name, viewContext, tree) =>
      void (await ask("views.update", { name, context: viewContext, tree })),
    log: (message) => send({ method: "log", params: { message } }),
  };
  const answer = async (message: Message) => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        context.extension = params.extension;
        context.folder = params.folder ?? "";
        context.storageArea = params.storage ?? "";
        context.settings = params.settings ?? {};
        await extension.start?.(context);
        return { contributes: contributes(extension) };
      case "action.run": {
        const action = extension.actions?.[params.action];
        if (!action) throw new Error(`No action \`${params.action}\``);
        return action.run(params.input, { ...context, caller: params.caller });
      }
      case "point.call": {
        const implementation = extension.implements?.find(
          (found) =>
            found.point === params.point &&
            found.name === params.implementation,
        );
        const operation = implementation?.operations[params.operation];
        if (!operation)
          throw new Error(
            `No implementation of ${params.point} \`${params.operation}\``,
          );
        return operation(params.input, context);
      }
      default:
        throw new Error(`Unknown method \`${message.method}\``);
    }
  };
  for await (const line of lines(input)) {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === undefined && message.id !== undefined) {
      const found = waiting.get(Number(message.id));
      waiting.delete(Number(message.id));
      if (message.error)
        found?.reject(new Error(message.error.message ?? "The kernel refused"));
      else found?.resolve(message.result);
      continue;
    }
    if (message.id === undefined) {
      if (message.method === "shutdown") return;
      if (message.method === "settings") {
        context.settings = message.params?.settings ?? {};
        void extension.settingsChanged?.(context);
      }
      if (message.method === "event") {
        const handler = extension.on?.[message.params?.name];
        if (handler)
          void Promise.resolve(handler(message.params?.payload, context)).catch(
            (error) =>
              context.log(`Event ${message.params?.name} failed: ${error}`),
          );
      }
      continue;
    }
    const id = message.id;
    answer(message).then(
      (result) => send({ id, result: result ?? null }),
      (error: unknown) =>
        send({
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        } as Message),
    );
  }
}
