import { expect, test } from "bun:test";
import { defaultTheme, themes, variantOf } from "./themes";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/** The custom properties a variant sets, sorted; none when it is missing. */
function variables(css: string, variant: string) {
  const start = css.indexOf(`@variant ${variant} {`);
  if (start < 0) return [];
  const block = css.slice(start, css.indexOf("}", start));
  return (block.match(/--[\w-]+(?=:)/g) ?? []).sort();
}

test("theme ids are distinct, and the default is one of them", () => {
  const ids = themes.map((theme) => theme.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain(defaultTheme);
  for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
});

test("every theme sets every token in both lights, with fonts every client has", async () => {
  const base = variables(await read("./theme.css"), "dark");
  const imports = await read("./themes.css");
  const web = await read("../../apps/web/src/index.css");
  const webFonts = await read("../../apps/web/src/fonts.css");
  const mobileFonts = await read("../../apps/mobile/app.json");
  for (const { id } of themes) {
    const css = await read(
      id === defaultTheme ? "./theme.css" : `./themes/${id}.css`,
    );
    for (const light of ["light", "dark"] as const) {
      expect(variables(css, variantOf(id, light))).toEqual(base);
      if (id !== defaultTheme)
        expect(web).toContain(
          `@custom-variant ${id}-${light} (&:where([data-theme="${id}"].${light}));`,
        );
    }
    if (id !== defaultTheme)
      expect(imports).toContain(`@import "./themes/${id}.css";`);
    for (const [, font] of css.matchAll(/--font-\w+: "([^"]+)"/g)) {
      expect(webFonts).toContain(`font-family: "${font}";`);
      expect(mobileFonts).toContain(`"fontFamily": "${font}"`);
    }
  }
});
