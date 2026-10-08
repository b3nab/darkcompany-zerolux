# Themes

ZeroLux comes with four themes: Signal, Vibe, Boreal and Zero. Each one has a light and a dark variant. Choose the theme and the light from the user menu or ⌘K on the web and desktop, or from More on mobile. Each device keeps its own choice.

Themes live in `packages/theme` and are shared by every client. The default theme is `theme.css` itself. The header of `theme.css` describes each token.

## Add a theme

1. Add an entry to `themes.json` with an `id` (lowercase letters, digits and hyphens), a `name` and a one-line `description`.
2. Create `themes/<id>.css`. Copy an existing theme and change its values: every theme sets the same tokens as `theme.css`, in both variants.

   ```css
   @layer theme {
     :root {
       @variant <id>-light {
         --font-sans: "Family";
         /* … every token */
       }
       @variant <id>-dark {
         /* … the same tokens */
       }
     }
   }
   ```

3. Import the file in `themes.css`.
4. Declare its variants for the web in `apps/web/src/index.css`:

   ```css
   @custom-variant <id>-light (&:where([data-theme="<id>"].light));
   @custom-variant <id>-dark (&:where([data-theme="<id>"].dark));
   ```

5. If the theme uses a new font, add its packages with `bun add` in `apps/web` and `apps/mobile`. Then register the font under the same family name in `apps/web/src/fonts.css` and in the `expo-font` plugin in `apps/mobile/app.json`. Mobile needs a new native build to use the font.

Mobile registers the themes from `themes.json` by itself. `bun test packages/theme` checks that every theme is complete and wired in.

## Glass

Two more tokens apply on the web and desktop:

- `--background-image` is painted behind the page, for example a gradient.
- `--surface-backdrop` is a `backdrop-filter` for cards, menus and the sidebar. Use it with translucent surface colors.

Set either one to `none` when the theme doesn't use it.
