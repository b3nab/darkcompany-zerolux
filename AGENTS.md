# Working on ZeroLux

Read `ZEROLUX.md` first: it defines the product. Then `README.md` and `docs/`.

## Stack

- Kernel: Rust, `crates/zerolux`.
- Web: React and TypeScript in `apps/web`, Tailwind v4 and shadcn/ui on Base UI (`bun x --bun shadcn add`). Colors and radii come only from `packages/theme/theme.css`.
- Mobile: Expo in `apps/mobile` (see its `AGENTS.md`).
- JavaScript: Bun only, for packages, scripts, bundling, dev server and tests. No npm, npx, pnpm, yarn, Node scripts or Vite. Run package CLIs with `bun x --bun`.
- Dependencies: add them with `bun add` or `cargo add`; lockfiles are their output.

## Rules

- The owner approves work. Do not commit, push, merge or deploy without the owner's direction.
- Tests use temporary directories and fake harnesses. No real models, paid APIs, credentials or personal sessions.
- Do not commit `.zerolux/`, environment files, logs or build output.

## Checks

Run `bun run check` from the root. Format Rust with `cargo fmt --all` and everything else with `bun run format`. Update tests and docs when behavior changes.
