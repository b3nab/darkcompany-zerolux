# Authentication and database foundations

Better Auth for sign-in, a Rust kernel on SeaORM, and both SQLite and PostgreSQL
as supported databases. SQLite is a product choice for local workspaces, not a
temporary backend. Redis, ClickHouse, another domain API and a general
storage-plugin framework are outside this design.

## Checks

- The integrated result must pass the complete root check on both databases.
  Its Rust runner executes the workspace suite without the PG variable (SQLite),
  then the kernel suite with the explicit test PG URL. The auth suite exercises
  both in the same run. A PG-only run must not replace SQLite coverage.
- Use temporary databases and fake harnesses. Do not migrate a live workspace,
  touch personal sessions or deploy a candidate as part of development.

## Persistence

The kernel owns domain tables and authorization. Better Auth owns its prefixed
`auth_*` tables through its supported adapter; Rust does not query those tables.
Both use the selected workspace database. Kernel migration and ownership locking
precede starting the auth service, so only one service migrates a workspace.
Both migration paths wrap their DDL in a transaction. The service passes a
transaction from Better Auth's pinned public Kysely adapter to `getMigrations`;
a late index/DDL failure rolls back its earlier schema changes too.

The kernel's queries go through SeaORM: entities for ordinary reads and writes,
explicit SQL where one statement must check and change at once. Migrations run
in one serialized transaction and keep every identity, date, message, receipt,
approval, Stop marker and delivery state. A database migrated by a newer kernel
fails closed, rather than being marked migrated.

### Entity-first migration workflow

- Entities are the authored schema. Migration artifacts must be generated during
  development, reviewed and versioned with the release, not maintained as a second
  handwritten schema.
- A deployed kernel applies the release's pending migrations in order through
  SeaORM Migration. It does not infer a new migration from the live database or
  run `SchemaBuilder::sync()` at startup.
- Applied migrations are immutable history. SQLite and PostgreSQL updates must
  preserve existing data and domain rules, including partial failures and attempts
  to open a newer database with an older kernel.
- `bun run db:generate <name>` exports the SeaORM entities and uses pinned Atlas
  Community Edition to generate both dialects on disposable development databases.
  Atlas is a development tool, never a kernel runtime dependency. No account or
  cloud service is required.
- CHECKs and partial/composite indexes belong to the relevant entity's SeaQuery
  definition, alongside its fields and relations. Existing constraints are not
  silently discarded because a derive attribute cannot express them.
- The owner-approved pre-release baseline is one generated `0001_bootstrap`,
  consolidating the four former migrations, with one artifact per dialect. Later
  changes append new versions. Existing databases carrying the retired history
  are not silently rebased; they need a separately approved data-preserving
  alignment before activation. See [the migration workflow](../crates/zerolux/migrations/README.md).
- SQLite table rebuilds use a private migration connection, check foreign keys
  before commit, then close it. The separate application pool has FK enforcement
  enabled. Automatic destructive `down` migrations are refused; recovery requires
  the matching backup and kernel version. Generation alone is not upgrade-test
  evidence or permission to activate a release.

SQLite and PostgreSQL have the same domain contract, not necessarily identical
SQL. Every domain write happens in a `Store::write()` transaction: one writer at
a time per workspace (SQLite's immediate transaction; a PostgreSQL advisory
lock), so a check made inside the transaction still holds when it commits.
Reads take one snapshot. A SQLite workspace is served by one kernel (a lock file
next to the database). A PostgreSQL workspace is served by any number of kernels:
the Better Auth secret lives in the `workspace` row, so a sign-in on one kernel
is valid on all; each agent session records the host
(`chat_sessions.host_id`, from `<data-dir>/host-id`) whose native process it is,
and only that kernel recovers and relinks it. Kernels of one workspace start
their authentication services one at a time. Several kernels need one external
LiveKit so notices reach every client.

### Native agent data and control

ZeroLux provides full observability and control over agents and all their output. Native history, output and events are kernel domain data; native controls are kernel capabilities. Chats, agents, automations and clients reuse them throughout the product. See [native observability and control](chat.md#native-observability-and-control).

## Authentication boundary

Use Better Auth 1.7.7 with its built-in Bun SQLite and PostgreSQL adapters. Start
with email/password sessions and the bearer plugin, not a custom password or JWT
implementation. Cookie caching is disabled. The kernel checks each human session
through the local service API; unavailable authentication never becomes owner
access. Revocation and logout therefore take effect on the next request.
Realtime notices are the one exception, by a minute: a person's LiveKit token
lasts 60 seconds and its identity carries that end, so a device signed out or
revoked is disconnected at once and hears no notice past the end of the token
it already had (at most 60 seconds from its issue), whatever it does with that
token; the sweep then closes what is left of the connection. Notices carry event
identifiers, never content.
Sessions expire after seven days. Clients call public `get-session` on startup,
return to the foreground and hourly while active; Better Auth refreshes sessions
when due (one-day update age). Private authorization checks never extend them.

- Web uses HttpOnly session cookies. Cookies are named per workspace, since
  cookies do not distinguish two ports on the same host.
- Desktop/mobile use the signed session token in `set-auth-token`, not the raw
  token in a JSON response. A token belongs to the kernel it signed in to,
  checked by the kernel's id before it is sent, and goes to that kernel's
  workspaces only, never to a different kernel. Mobile uses Expo
  SecureStore; desktop keeps the token only in the current window's memory and
  signs in again when a window is recreated. No desktop keychain command or
  persistent token store is part of this work.
- Native agents retain their separate session-scoped credentials and permissions.
  Neither a browser cookie nor a human account becomes an agent credential.
- Better Auth identifies a user. The kernel binds that subject to a domain actor
  and authorizes the action. Registration alone grants no workspace privileges.
- Registration is open until the owner has an account. The first authenticated
  account to complete the claim binds to the existing owner actor, and registration
  then closes. Concurrent claims cannot replace the owner. Existing names/history
  remain. Complete registration before exposing a new workspace to untrusted users.
- After that, people join by invitation: the owner creates one, valid once for seven
  days; the person signs up with it and claims it, becoming a new human actor whose
  `invited_by` names the owner. The owner is the human without `invited_by`.
- `/api/health` remains public for connection identity and setup status. Domain
  endpoints require a bound human identity or their existing scoped agent token.
  No implicit owner identity for a request without credentials.
- Web, desktop and mobile support one kernel on the owner's own computer, with
  mobile connected over the LAN. HTTP through the existing explicit `--expose`
  address is supported; public origins require HTTPS. HTTP does not encrypt
  passwords or sessions, so use it only on a trusted local network. Preserve
  exact Host/Origin checks and CSRF protection: permitting one declared LAN
  origin does not trust a whole subnet or forwarded headers. Desktop CORS permits
  the known app origins, not `*`. No tunnels, certificate-management feature or
  live installation change is part of this work.

### Client-facing kernel contract

- `/api/health` adds capability `auth-v1` and
  `auth: {setup_required: boolean}`. The breaking authentication requirement
  is announced by `api_version` 2; clients never refuse a kernel by its version,
  they use the capabilities it declares.
- `GET /api/auth/identity` requires a valid human session and returns
  `{user: {id, name, email}, actor_id: string | null, owner: boolean, setup_required: boolean}`;
  `owner` tells the workspace's owner from a person who joined.
  It allows an unbound account to see that enrollment is required, not domain data.
- `POST /api/auth/sign-up/email` accepts name, email and password while
  `auth.setup_required` is true. Once the owner is bound it needs the header
  `x-zerolux-invite: <token>` of a usable invitation, and a name no member has;
  without one it returns 403, with a used, withdrawn or expired one 410. Better Auth applies its database-backed rate limiter.
  An account is not privileged until bound. The kernel must not hold a write
  transaction across the sidecar call: both components write the same SQLite database.
- `POST /api/auth/claim` has no request body, or `{invite}`. Under a valid human
  session it atomically binds the first claiming account to the existing owner, or
  with an invitation makes the account a new person and uses the invitation up; it
  returns the identity response. Clients claim after signup. Keeping claim separate allows
  recovery through sign-in if registration succeeded but enrollment was interrupted.
- Sign-in/out, get-session, list/revoke sessions and change-password use the
  matching Better Auth endpoints under `/api/auth`. Preserve its HTTP statuses,
  cookies and `set-auth-token`; do not turn an auth failure into a success envelope.
- `GET /api/auth/invites/{token}` needs no account: `{invitation: {workspace,
  invited_by, expires_at}}` while it can be used, 410 otherwise. The owner creates
  invitations with `POST /api/invites` (`{invite: {id, created_by, created_at,
  expires_at}, token}`; the token is in this answer only), lists unused ones with
  `GET /api/invites` and withdraws one with `DELETE /api/invites/{id}`.
- Desktop CORS must allow `authorization`, `content-type` and `x-zerolux-invite`, and expose
  `set-auth-token` for the known app origins.

### Private service protocol (version 1)

`bun services/auth/src/server.ts` reads one JSON configuration line from stdin.
The kernel keeps that pipe open for the lifetime of the service; EOF shuts down
this child, with a five-second cleanup deadline even if a database query hangs.
Secrets are not command-line arguments. Configuration:

```typescript
{
  version: 1;
  workspace_id: string; // workspace UUID
  database: { kind: "sqlite"; path: string }
          | { kind: "postgres"; url: string };
  base_url: string; // kernel origin: HTTPS, or loopback/LAN HTTP
  trusted_origins: string[]; // exact configured client origins
  secret: string; // stable per-workspace Better Auth signing secret, >=32 bytes
  control_token: string; // private random credential for this kernel process
}
```

SQLite paths are absolute. The service listens only on `127.0.0.1`, port 0. After
schema validation/migration it prints one line:

```json
{
  "type": "ready",
  "version": 1,
  "pid": 123,
  "address": "http://127.0.0.1:45678",
  "workspace_id": "…"
}
```

A startup failure prints `{"type":"failed","version":1,"reason":"config"}`
(or `database` / `listen`) and exits nonzero. The category is nonsecret; neither
stdout nor stderr includes the configuration or underlying database error.

All requests require `x-zerolux-auth-service: <control_token>`. The kernel never
accepts this header from a public caller; it constructs the private request.
Only pass the required cookie/authorization, content type, Origin and user-agent
headers. Do not trust forwarded-host/proto/IP supplied by a caller. The kernel
supplies the TCP peer address as `x-zerolux-client-ip` for auth limiting. Forwarded
IP/protocol headers are considered only when the actual peer is an explicitly
configured trusted reverse proxy; otherwise they are ignored. A private subnet
is not automatically a trusted proxy.

- `GET /internal/health`: readiness/version/workspace identity, no secrets.
- `GET /internal/session`: validate incoming Cookie **or** signed Authorization
  bearer through `auth.api.getSession`, with `disableCookieCache` and
  `disableRefresh`. Returns `null` or
  `{subject, session_id, expires_at, name, email}`; expiry is Unix milliseconds.
  A bearer request never falls back to its cookies. Invalid sessions return null;
  storage/service failures return 503, not an anonymous identity.
- `/api/auth/*`: Better Auth's HTTP handler. The kernel proxies the supported
  authentication routes, preserving status, Set-Cookie and `set-auth-token`,
  never exposing private `/internal/*` routes. Signup additionally requires
  `x-zerolux-auth-enroll: 1`, injected **only** after the kernel checks that the
  owner has no account yet, or that the signup carries a usable invitation. Requests cannot grant themselves that permission.

Use bounded startup/HTTP/shutdown deadlines. Stop the auth child on kernel
shutdown; an auth outage must not kill, restart or duplicate native agent work.
The Better Auth secret is a column of the `workspace` row (never serialized to
clients). It does not belong in the repository or logs.

## Acceptance

- Existing SQLite workspace migrates without losing or changing identities,
  histories, pending/uncertain delivery states or owner Stop decisions.
- SQLite and PostgreSQL pass the same relevant persistence, concurrency,
  authentication and API authorization scenarios, including failure paths; two
  kernels on one PostgreSQL workspace share sign-in and keep to their own agent
  sessions.
- Real Better Auth with temporary SQLite/PostgreSQL databases: enrollment,
  sign-in, cookie/bearer validation, logout/revocation, restart continuity and
  isolation across workspaces. No external identity provider or model calls.
- Forged, missing, expired or revoked credentials cannot obtain owner access;
  an authenticated but unbound subject cannot access the workspace.
- Web, desktop and mobile can authenticate and sign out; a connection change
  never sends one workspace's credentials to another.
- Backup/restore and schema-upgrade failure behavior are documented and tested.
  No readiness claim from a partial check; no activation without the owner.

## Verified library references

Better Auth documentation was checked at the pinned `v1.7.7` tag, alongside the
installed source (not only examples from another release):

- [Bun SQLite adapter](https://www.better-auth.com/docs/adapters/sqlite)
- [PostgreSQL adapter](https://www.better-auth.com/docs/adapters/postgresql)
- [Bearer plugin](https://www.better-auth.com/docs/plugins/bearer)
- [Session management](https://www.better-auth.com/docs/concepts/session-management)

`getMigrations` is exported by `better-auth/db/migration`. Its migration runner
executes statements sequentially; the kernel serializes the services' starts
across kernels of one PostgreSQL workspace.
