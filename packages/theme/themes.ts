import registry from "./themes.json";

/**
 * The themes every client offers, from themes.json. Each has a light and a dark variant: the
 * default theme's are theme.css's plain `light` and `dark`, every other theme's are
 * `<id>-light` and `<id>-dark` in themes/<id>.css. See docs/themes.md.
 */
export type ThemeInfo = { id: string; name: string; description: string };
export type Light = "light" | "dark";

export const themes: ThemeInfo[] = registry.themes;
export const defaultTheme: string = registry.default;

/** A saved theme that still exists, otherwise the default. */
export const knownTheme = (id: string | null | undefined): string =>
  themes.find((theme) => theme.id === id)?.id ?? defaultTheme;

/** The variant that carries a theme in one light. */
export const variantOf = (theme: string, light: Light) =>
  theme === defaultTheme ? light : `${theme}-${light}`;

/** The named variants, for a client that registers them (Uniwind's extra themes). */
export const namedVariants = themes
  .filter((theme) => theme.id !== defaultTheme)
  .flatMap((theme) => [`${theme.id}-light`, `${theme.id}-dark`]);
