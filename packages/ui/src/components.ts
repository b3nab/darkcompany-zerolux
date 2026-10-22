import type { ComponentType, ReactNode } from "react";

/** How loud a part says what it says. */
export type Tone = "default" | "muted" | "success" | "warning" | "danger";

/** An option among others, by its value. */
export interface Choice {
  value: string;
  label: string;
}

/** Parts one above another, or side by side. */
export interface StackProps {
  /** As in a described view's `stack`: a column by default. */
  direction?: "column" | "row";
  /** Space between the parts, in points. */
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  children?: ReactNode;
}

export interface TextProps {
  tone?: Tone;
  size?: "sm" | "md";
  /** Machines' text: handles, ids, times, code. */
  mono?: boolean;
  children?: ReactNode;
}

export interface HeadingProps {
  level?: 1 | 2 | 3;
  children?: ReactNode;
}

/** Text written in Markdown, drawn as the app draws messages. */
export interface MarkdownProps {
  children: string;
}

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  /** Running what it started: it waits, and shows it. */
  busy?: boolean;
}

/** An icon by its Lucide name, as `kanban` or `file-text`; one the app lacks shows as a puzzle. */
export interface IconProps {
  name: string;
  size?: number;
  tone?: Tone;
}

export interface IconButtonProps {
  icon: string;
  /** What it does, for those who hear the screen. */
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
  disabled?: boolean;
  /** Ready to type in as it shows, as in a sheet that asks for a name. */
  autoFocus?: boolean;
  onSubmit?: () => void;
}

export interface SelectProps {
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

export interface SwitchProps {
  value: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
}

/** Rows in a frame of their own; each row is a `ListItem`. */
export interface ListProps {
  children?: ReactNode;
}

/**
 * What can be dragged and where it lands: a row or a card carries `drag`, the id it is known
 * by; one with `onDrop` takes what is dropped on it, as a folder takes files. On a phone,
 * nothing drags: its menu moves things instead.
 */
export interface Droppable {
  drag?: string;
  /** `copy`: ⌥ was held, as in Finder, to copy instead of moving. */
  onDrop?: (ids: string[], copy: boolean) => void;
}

export interface ListItemProps extends Droppable {
  title: string;
  subtitle?: string;
  /** Before the title: an icon or an avatar. */
  leading?: ReactNode;
  /** After it: a badge, a switch, a count. */
  accessory?: ReactNode;
  /** A row that does something shows that it does. */
  onPress?: () => void;
  /** The row open beside the list, as in a Split. */
  selected?: boolean;
  /** What can be done with it: its "…", a right click, a long press on a phone. */
  menu?: MenuEntry[];
}

/** A group of rows under its name, with what can be added to it, as a source and its projects. */
export interface SectionProps {
  title: string;
  /** Beside the name: an IconButton or a Menu. */
  actions?: ReactNode;
  children?: ReactNode;
}

export interface TableColumn {
  key: string;
  title: string;
  /** Numbers and sizes end on the right. */
  align?: "start" | "end";
}

export interface TableRow extends Droppable {
  /** How it is known in a selection and a drag. */
  id: string;
  /** Its icon by Lucide name, large in the icons view. */
  icon?: string;
  cells: Record<string, ReactNode>;
  /** Opens it: a double click or Enter, a tap on a phone. */
  onOpen?: () => void;
  /** What can be done with it: a right click, a long press on a phone. */
  menu?: MenuEntry[];
}

/**
 * Rows under their columns, chosen as in the system's own lists: a click, ⌘ for more, ⇧ for a
 * range, ⌘A for all and Esc for none; on a phone, Select and taps.
 */
export interface TableProps {
  columns: TableColumn[];
  rows: TableRow[];
  /** As a list under the columns, or as icons named by the first column, as in Finder. */
  view?: "list" | "icons";
  /** The rows chosen, by id; without `onSelect` none are. */
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  /**
   * What can be done with all the rows chosen: in a bar along the bottom while more than one
   * is, and on a right click among them.
   */
  selectionMenu?: MenuEntry[];
  /** The column it is sorted by; pressing a column's title sorts by it, again the other way. */
  sort?: { key: string; descending?: boolean };
  onSort?: (sort: { key: string; descending: boolean }) => void;
  /** Said when there are no rows. */
  empty?: string;
}

export interface BadgeProps {
  tone?: Tone;
  children?: ReactNode;
}

/** Said where there is nothing yet to show. */
export interface EmptyProps {
  children?: ReactNode;
}

/** An image carried in the view itself (`data:image/…`): nothing loads from outside. */
export interface ImageProps {
  src: string;
  alt: string;
  height?: number;
}

export interface CardProps extends Droppable {
  title?: string;
  /** A card that opens something shows that it does. */
  onPress?: () => void;
  /** The card open beside the list, as a task in the inspector. */
  selected?: boolean;
  /** What can be done with it: its "…" by the title, a right click, a long press on a phone. */
  menu?: MenuEntry[];
  children?: ReactNode;
}

/** Cards side by side, each as wide as the others, scrolled sideways when they do not fit. */
export interface ColumnsProps {
  children?: ReactNode;
}

/**
 * A list beside what is chosen in it, as a storage's places beside their files. Where there is
 * room both show, the list at the side, as wide as the reader drags it; on a phone the list
 * shows, and once something is open its detail takes its place, with the way back.
 */
export interface SplitProps {
  /** What the list holds: its label, its title on top, and the way back to it. */
  label: string;
  /** Beside the list's title: what adds to it, as an IconButton. */
  actions?: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  /** Something in the list is open: on a phone its detail shows instead of the list. */
  open: boolean;
  /** Back to the list, on a phone. */
  onBack: () => void;
}

/** A day, as `YYYY-MM-DD`, picked with the system's calendar; `null` is none. */
export interface DateInputProps {
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Something to do with what a row shows; with `items`, a submenu of choices instead. */
export interface MenuItem {
  title: string;
  icon?: string;
  tone?: "danger";
  disabled?: boolean;
  /** The choice made, among its neighbours, as the current status. */
  checked?: boolean;
  /** The keys that do it on a computer, as the system writes them: `⌘⌫`, `⇧⌘N`. */
  shortcut?: string;
  onPress?: () => void;
  items?: MenuEntry[];
  /** Picks files instead, as a FileButton: Upload in a folder's menu. */
  onFiles?: (files: PickedFile[]) => void;
  multiple?: boolean;
}

/** A line of a menu: something to do, a line between groups, or a group's name. */
export type MenuEntry = MenuItem | { divider: true } | { section: string };

/** What can be done with something, behind one button: a menu here, an action sheet on a phone. */
export interface MenuProps {
  /** What the button opens, for those who hear the screen. */
  label: string;
  /** Its icon, by Lucide name; `ellipsis` by default. */
  icon?: string;
  items: MenuEntry[];
}

/** A place on the way to where a page is: pressing one goes back to it. */
export interface Crumb {
  title: string;
  onPress?: () => void;
}

/**
 * A screen as the app's own are: a header that says where you are and holds what you can do,
 * then what it shows; while something is open in it, an inspector beside it.
 */
export interface PageProps {
  /** Where you are: a title, or the way to it, the last being here. */
  title: string | Crumb[];
  /** Beside the title: a key, a source. */
  subtitle?: string;
  /** Searching what the page shows, in its header. */
  search?: {
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
  };
  /** In the header: Tabs for views, Buttons, a Menu. A primary Button is the page's main action. */
  actions?: ReactNode;
  /** What is open, beside what the page shows; on a phone, over it. */
  inspector?: { title: string; content: ReactNode; onClose: () => void };
  /** What can be done where nothing is: a right click on the empty page, a long press. */
  menu?: MenuEntry[];
  children?: ReactNode;
}

/**
 * A folder on the computer ZeroLux runs on, chosen and never typed: with the system's own
 * panel where that computer is this one, else in a sheet that walks its folders.
 */
export interface FolderInputProps {
  value: string | null;
  onChange: (path: string) => void;
  label?: string;
  disabled?: boolean;
}

/** A file a person picked or dropped, with its name. */
export interface PickedFile {
  file: Blob;
  name: string;
}

/** A button that opens the system's choice of files. */
export interface FileButtonProps {
  title: string;
  onFiles: (files: PickedFile[]) => void;
  multiple?: boolean;
  variant?: ButtonProps["variant"];
  busy?: boolean;
  disabled?: boolean;
}

/** Where files dragged onto the view land; on a phone, only what it holds. */
export interface DropZoneProps {
  onFiles: (files: PickedFile[]) => void;
  /** Said while files are held over it. */
  label: string;
  disabled?: boolean;
  children?: ReactNode;
}

/** A choice among views of the same thing; what each shows is the view's own. */
export interface TabsProps {
  items: Choice[];
  value: string;
  onChange: (value: string) => void;
}

/** Over the view, until it is closed: a sheet on a phone, a dialog elsewhere. */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
}

export interface SpinnerProps {
  size?: "sm" | "md";
}

/** A person or an agent of the workspace, as the app marks them. */
export interface AvatarProps {
  actorId: string;
  size?: "sm" | "md";
}

/**
 * The components an extension's view draws with. Each app gives its own, in its design:
 * the same props mean the same thing everywhere.
 */
export interface UiComponents {
  Stack: ComponentType<StackProps>;
  Text: ComponentType<TextProps>;
  Heading: ComponentType<HeadingProps>;
  Markdown: ComponentType<MarkdownProps>;
  Button: ComponentType<ButtonProps>;
  IconButton: ComponentType<IconButtonProps>;
  Icon: ComponentType<IconProps>;
  Input: ComponentType<InputProps>;
  Select: ComponentType<SelectProps>;
  Switch: ComponentType<SwitchProps>;
  List: ComponentType<ListProps>;
  ListItem: ComponentType<ListItemProps>;
  Table: ComponentType<TableProps>;
  Badge: ComponentType<BadgeProps>;
  Divider: ComponentType;
  Empty: ComponentType<EmptyProps>;
  Image: ComponentType<ImageProps>;
  Card: ComponentType<CardProps>;
  Tabs: ComponentType<TabsProps>;
  Sheet: ComponentType<SheetProps>;
  Spinner: ComponentType<SpinnerProps>;
  Avatar: ComponentType<AvatarProps>;
  Columns: ComponentType<ColumnsProps>;
  Split: ComponentType<SplitProps>;
  Section: ComponentType<SectionProps>;
  Page: ComponentType<PageProps>;
  FolderInput: ComponentType<FolderInputProps>;
  DateInput: ComponentType<DateInputProps>;
  Menu: ComponentType<MenuProps>;
  FileButton: ComponentType<FileButtonProps>;
  DropZone: ComponentType<DropZoneProps>;
}

/** The components' names, as the apps must give them all. */
export const componentNames = [
  "Stack",
  "Text",
  "Heading",
  "Markdown",
  "Button",
  "IconButton",
  "Icon",
  "Input",
  "Select",
  "Switch",
  "List",
  "ListItem",
  "Table",
  "Badge",
  "Divider",
  "Empty",
  "Image",
  "Card",
  "Tabs",
  "Sheet",
  "Spinner",
  "Avatar",
  "Columns",
  "Split",
  "Section",
  "Page",
  "FolderInput",
  "DateInput",
  "Menu",
  "FileButton",
  "DropZone",
] as const satisfies readonly (keyof UiComponents)[];
