# Mobile app

Expo (React Native) app for iOS and Android. It talks to a running kernel over HTTP and receives chat updates through LiveKit.

## Stack

- Expo Router: every file in `app/` is a screen, `_layout.tsx` files are navigators. Components, hooks and helpers live outside `app/`.
- Styling: Tailwind v4 through Uniwind (`global.css`), tokens only from the themes in `packages/theme`. Components from React Native Reusables (`components/ui`), lists with Legend List, keyboard handling with `react-native-keyboard-controller`.
- Shared chat logic comes from `packages/chat`.
- Messages render with `react-native-enriched-markdown`; Mermaid diagrams with the `mermaid` package inside an Expo DOM component.

## Commands

Bun only, as in the root `AGENTS.md`: no npm, npx or Node scripts.

```bash
bun x --bun expo install <package>   # add a dependency at an SDK-compatible version
bun x --bun expo start               # dev server for a development build
bun run typecheck                    # tsc --noEmit
bun x --bun expo prebuild            # regenerate ios/ and android/ (never edit them by hand)
```

Expo changes every SDK release: check the `expo` version in `package.json` and read the matching docs at `https://docs.expo.dev/versions/v<major>.0.0/` before touching an Expo or React Native API.

## Rules

- `ios/` and `android/` are generated and ignored by git; native behavior is configured in `app.json` and config plugins.
- Native modules need a development or release build, not Expo Go.
- Run typecheck and `bun run format` before declaring work done.
