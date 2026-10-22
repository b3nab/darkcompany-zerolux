import { defineExtension, serve, type Context } from "./zerolux.ts";
import { clean, drive, folderId, returnTo } from "./provider.ts";

let context: Context | undefined;

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
/** All of Drive: every file the person can reach, as they can. */
const SCOPES = ["https://www.googleapis.com/auth/drive"];
/**
 * The OAuth client this extension's publisher registered with Google, if any: who adds a
 * location chooses it, or their own. None yet.
 */
const PUBLISHER = undefined as { id: string; secret: string } | undefined;

/** A location's configuration, as people see it. */
interface Config {
  folder: string;
  /** `publisher` or `own`. */
  client: string;
  client_id?: string;
}

interface Client {
  client_id: string;
  client_secret?: string;
}

const tokens = (location: string) => `location:${location}`;
const clients = (location: string) => `client:${location}`;
const text = (value: unknown) => String(value ?? "").trim();

// One Drive for each location, as long as this process runs.
const drives = new Map<
  string,
  { root: string; drive: ReturnType<typeof drive> }
>();
function driveOf(location: string, config: Config) {
  if (!context) throw new Error("Not started");
  const root = folderId(config.folder ?? "");
  const held = drives.get(location);
  if (held?.root === root) return held.drive;
  const made = drive(
    root,
    async () => (await context!.oauth.token(tokens(location))).access_token,
    () => context?.folder ?? "",
  );
  drives.set(location, { root, drive: made });
  return made;
}

interface Input {
  location: string;
  config: Config;
}

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.storage/providers@2",
        name: "drive",
        title: "Google Drive",
        operations: {
          describe: async () => ({
            title: "Google Drive",
            description: "My Drive, one of its folders, or a shared drive",
            fields: [
              {
                key: "folder",
                label: "Folder",
                type: "text",
                description:
                  "A folder's address or ID; all of My Drive when empty",
              },
              ...(PUBLISHER
                ? [
                    {
                      key: "client",
                      label: "Sign in with",
                      type: "choice",
                      required: true,
                      options: [
                        { value: "publisher", label: "ZeroLux's Google app" },
                        { value: "own", label: "My own Google app" },
                      ],
                    },
                  ]
                : []),
              {
                key: "client_id",
                label: "OAuth client ID",
                type: "text",
                required: !PUBLISHER,
                description: PUBLISHER
                  ? "With my own Google app"
                  : "From your Google Cloud project",
              },
              {
                key: "client_secret",
                label: "OAuth client secret",
                type: "secret",
                required: !PUBLISHER,
                description: PUBLISHER ? "With my own Google app" : undefined,
              },
            ],
            sign_in: true,
            capabilities: ["write", "move", "copy", "delete", "search"],
          }),
          connect: async (input: {
            location: string;
            config: Record<string, unknown>;
            previous?: Partial<Config>;
            origin?: string;
          }) => {
            if (!context) throw new Error("Not started");
            const given = input.config;
            const previous = input.previous ?? {};
            const folder =
              "folder" in given ? text(given.folder) : text(previous.folder);
            folderId(folder);
            const choice = PUBLISHER
              ? text(given.client ?? previous.client) || "publisher"
              : "own";
            const held = await context.vault.get<Client>(
              clients(input.location),
            );
            let client: Client;
            if (choice === "publisher" && PUBLISHER) {
              client = {
                client_id: PUBLISHER.id,
                client_secret: PUBLISHER.secret,
              };
            } else {
              const id = text(given.client_id) || held?.client_id || "";
              const secret =
                text(given.client_secret) ||
                (id === held?.client_id ? held?.client_secret : "") ||
                "";
              if (!id) throw new Error("Give the OAuth client ID");
              client = { client_id: id, client_secret: secret || undefined };
            }
            await context.vault.set(clients(input.location), client);
            const config: Config = {
              folder,
              client: choice,
              client_id: choice === "own" ? client.client_id : undefined,
            };
            drives.delete(input.location);
            const signedIn =
              (await context.vault.get(tokens(input.location))) !== undefined;
            const sameClient = held?.client_id === client.client_id;
            if (signedIn && sameClient && !given.sign_in_again) {
              const checked = await driveOf(input.location, config).check();
              return { config, account: checked.account };
            }
            const started = await context.oauth.start({
              secret: tokens(input.location),
              authorize_url: AUTHORIZE,
              token_url: TOKEN,
              client_id: client.client_id,
              client_secret: client.client_secret,
              scopes: SCOPES,
              // A refresh token every time, so the location keeps working.
              params: {
                access_type: "offline",
                prompt: "consent",
                include_granted_scopes: "true",
              },
              origin: returnTo(input.origin),
            });
            return { config, sign_in: { url: started.url } };
          },
          check: async (input: Input) =>
            driveOf(input.location, input.config).check(),
          forget: async (input: { location: string }) => {
            drives.delete(input.location);
            await context?.vault.delete(tokens(input.location));
            await context?.vault.delete(clients(input.location));
            return {};
          },
          list: async (input: Input & { path?: string }) =>
            driveOf(input.location, input.config).list(clean(input.path ?? "")),
          stat: async (input: Input & { path: string }) =>
            driveOf(input.location, input.config).stat(input.path),
          read: async (input: Input & { path: string }) =>
            driveOf(input.location, input.config).read(input.path),
          write: async (input: Input & { path: string; from: string }) =>
            driveOf(input.location, input.config).write(input.path, input.from),
          mkdir: async (input: Input & { path: string }) =>
            driveOf(input.location, input.config).mkdir(input.path),
          move: async (input: Input & { from: string; to: string }) =>
            driveOf(input.location, input.config).move(input.from, input.to),
          copy: async (input: Input & { from: string; to: string }) =>
            driveOf(input.location, input.config).copy(input.from, input.to),
          delete: async (input: Input & { path: string }) =>
            driveOf(input.location, input.config).delete(input.path),
          search: async (input: Input & { query: string }) =>
            driveOf(input.location, input.config).search(input.query),
        },
      },
    ],
    on: {
      // A location's sign-in ended: Storage hears whether it worked, and with which account.
      async "zerolux/signed_in"(payload, started) {
        const { secret, ok, error } = payload as {
          secret: string;
          ok: boolean;
          error?: string;
        };
        if (!secret.startsWith("location:")) return;
        const location = secret.slice("location:".length);
        drives.delete(location);
        let account: string | undefined;
        let failed = error;
        if (ok) {
          try {
            const about = await fetch(
              "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
              {
                headers: {
                  authorization: `Bearer ${(await started.oauth.token(secret)).access_token}`,
                },
              },
            );
            account = (
              (await about.json()) as { user?: { emailAddress?: string } }
            ).user?.emailAddress;
          } catch (reason) {
            failed = `Google Drive could not be reached: ${(reason as Error).message}`;
          }
        }
        await started.run("zerolux.storage", "signed_in", {
          location,
          ok: ok && !failed,
          ...(failed ? { error: failed } : {}),
          ...(account ? { account } : {}),
        });
      },
    },
  }),
);
