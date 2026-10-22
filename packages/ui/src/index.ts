/**
 * What an extension's view is written with: React, these components and these hooks. The
 * app that shows the view gives the components in its own design; the bundle leaves this
 * module out, and the app hands it in.
 */
import type { UiComponents } from "./components";

export type * from "./components";
export {
  useAction,
  useActionResult,
  useActors,
  useDownload,
  useEvent,
  useOpen,
  useSpace,
  useUpload,
} from "./hooks";

export declare const Stack: UiComponents["Stack"];
export declare const Text: UiComponents["Text"];
export declare const Heading: UiComponents["Heading"];
export declare const Markdown: UiComponents["Markdown"];
export declare const Button: UiComponents["Button"];
export declare const IconButton: UiComponents["IconButton"];
export declare const Icon: UiComponents["Icon"];
export declare const Input: UiComponents["Input"];
export declare const Select: UiComponents["Select"];
export declare const Switch: UiComponents["Switch"];
export declare const List: UiComponents["List"];
export declare const ListItem: UiComponents["ListItem"];
export declare const Table: UiComponents["Table"];
export declare const Badge: UiComponents["Badge"];
export declare const Divider: UiComponents["Divider"];
export declare const Empty: UiComponents["Empty"];
export declare const Image: UiComponents["Image"];
export declare const Card: UiComponents["Card"];
export declare const Tabs: UiComponents["Tabs"];
export declare const Sheet: UiComponents["Sheet"];
export declare const Spinner: UiComponents["Spinner"];
export declare const Avatar: UiComponents["Avatar"];
export declare const Columns: UiComponents["Columns"];
export declare const DateInput: UiComponents["DateInput"];
export declare const Menu: UiComponents["Menu"];
export declare const FileButton: UiComponents["FileButton"];
export declare const DropZone: UiComponents["DropZone"];
