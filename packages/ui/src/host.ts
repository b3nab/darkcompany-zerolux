/**
 * What an app needs to show extensions' native views: the module their bundles require as
 * `@zerolux/ui`, where a view shows, and the views their bundles define.
 */
import { createElement, useMemo } from "react";
import type { ComponentType, ReactNode } from "react";
import { useActions } from "@zerolux/chat";
import type { ExtensionAction } from "@zerolux/chat";
import { componentNames } from "./components";
import type { UiComponents } from "./components";
import * as hooks from "./hooks";
import { HereContext } from "./hooks";
import type { Here } from "./hooks";

export type { Here } from "./hooks";
export { componentNames } from "./components";
export type { UiComponents } from "./components";
export { callAction, eventName, receiveFile, sendFile } from "./hooks";

const NONE: ExtensionAction[] = [];

/**
 * Where a view shows, for the hooks it calls: the extension's actions are read once here,
 * and the same place gives the same value, so nothing is read again for nothing.
 */
export function UiSpace({
  piece,
  context,
  kernel,
  save,
  children,
}: Here & { children: ReactNode }) {
  const { actions, error } = useActions(kernel);
  const place = JSON.stringify(context);
  // Unreadable actions leave the inputs as the view writes them.
  const known = actions ?? (error ? NONE : undefined);
  const value = useMemo(
    () => ({
      piece,
      context: JSON.parse(place) as Here["context"],
      kernel,
      save,
      actions: known,
    }),
    [piece, place, kernel, save, known],
  );
  return createElement(HereContext.Provider, { value }, children);
}

/** `@zerolux/ui` as an app gives it to a view: its components with the shared hooks. */
export function uiModule(components: UiComponents) {
  const missing = componentNames.filter((name) => !components[name]);
  if (missing.length)
    throw new Error(
      `The app lacks ${missing.join(", ")} for extensions' views`,
    );
  return {
    ...components,
    useSpace: hooks.useSpace,
    useAction: hooks.useAction,
    useActionResult: hooks.useActionResult,
    useEvent: hooks.useEvent,
    useUpload: hooks.useUpload,
    useDownload: hooks.useDownload,
  };
}

/** The factory a view's bundle wraps itself in. */
type Factory = (
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
  require: (name: string) => unknown,
) => void;

declare global {
  // Defined by the app before a view's bundle runs: the bundle calls it with itself.
  var __zeroluxModule: ((entry: string, factory: Factory) => void) | undefined;
}

/**
 * Defines `__zeroluxModule` for views' bundles, which may require only `modules`. `current`
 * names the bundle running now, as the app loads it: its view is kept by that name.
 */
export function moduleHost(
  modules: Record<string, unknown>,
  current: () => string | undefined,
) {
  const views = new Map<string, ComponentType>();
  const require = (name: string) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(
      `A view may use only ${Object.keys(modules).join(", ")}, not ${name}`,
    );
  };
  globalThis.__zeroluxModule = (entry, factory) => {
    const module = { exports: {} as Record<string, unknown> };
    factory(module, module.exports, require);
    const view = module.exports.default;
    if (
      !(
        typeof view === "function" ||
        (typeof view === "object" && view !== null)
      )
    )
      throw new Error(`${entry} gives no view`);
    views.set(current() ?? entry, view as ComponentType);
  };
  return {
    /** The view a bundle defined, by the name it ran under. */
    view: (name: string) => views.get(name),
  };
}
