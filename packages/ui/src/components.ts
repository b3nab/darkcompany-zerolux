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

export interface ListItemProps {
  title: string;
  subtitle?: string;
  /** Before the title: an icon or an avatar. */
  leading?: ReactNode;
  /** After it: a badge, a switch, a count. */
  accessory?: ReactNode;
  /** A row that does something shows that it does. */
  onPress?: () => void;
}

export interface TableProps {
  columns: { key: string; title: string }[];
  rows: Record<string, ReactNode>[];
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

export interface CardProps {
  title?: string;
  /** A card that opens something shows that it does. */
  onPress?: () => void;
  children?: ReactNode;
}

/** Cards side by side, each as wide as the others, scrolled sideways when they do not fit. */
export interface ColumnsProps {
  children?: ReactNode;
}

/** A day, as `YYYY-MM-DD`, picked with the system's calendar; `null` is none. */
export interface DateInputProps {
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Something to do with what a row shows. */
export interface MenuItem {
  title: string;
  icon?: string;
  tone?: "danger";
  disabled?: boolean;
  onPress: () => void;
}

/** What can be done with something, behind one button: a menu here, an action sheet on a phone. */
export interface MenuProps {
  /** What the button opens, for those who hear the screen. */
  label: string;
  /** Its icon, by Lucide name; `ellipsis` by default. */
  icon?: string;
  items: MenuItem[];
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
  "DateInput",
  "Menu",
  "FileButton",
  "DropZone",
] as const satisfies readonly (keyof UiComponents)[];
