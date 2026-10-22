import {
  Button as NativeButton,
  ContextMenu,
  Host,
  Image as NativeImage,
  Menu as NativeMenu,
  RNHostView,
  Section as NativeSection,
  Text as NativeText,
  Toggle,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react-native";
import { useState } from "react";
import type { ComponentProps, ReactElement } from "react";
import { ActionSheetIOS, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import type { MenuEntry, MenuItem, MenuProps } from "@zerolux/ui";
import { fileSources } from "@/components/pick-files";
import { Icon, IconButton } from "@/components/ui-icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useTheme } from "../src/theme";

type Symbol = NonNullable<ComponentProps<typeof NativeButton>["systemImage"]>;

/** The SF Symbols for the Lucide icons menus use; one not here shows no icon. */
const symbols: Record<string, Symbol> = {
  ellipsis: "ellipsis",
  plus: "plus",
  check: "checkmark",
  x: "xmark",
  eye: "eye",
  "eye-off": "eye.slash",
  download: "arrow.down.circle",
  upload: "arrow.up.circle",
  share: "square.and.arrow.up",
  "share-2": "square.and.arrow.up",
  "message-square-share": "bubble.left.and.text.bubble.right",
  pencil: "pencil",
  "square-pen": "square.and.pencil",
  folder: "folder",
  "folder-closed": "folder",
  "folder-input": "folder",
  "folder-plus": "folder.badge.plus",
  file: "doc",
  "file-text": "doc.text",
  copy: "doc.on.doc",
  link: "link",
  "external-link": "arrow.up.right.square",
  "trash-2": "trash",
  trash: "trash",
  pin: "pin",
  "pin-off": "pin.slash",
  archive: "archivebox",
  "archive-restore": "tray.and.arrow.up",
  "git-fork": "arrow.triangle.branch",
  "message-square": "message",
  phone: "phone",
  pause: "pause",
  play: "play",
  "user-plus": "person.badge.plus",
  user: "person",
  "rotate-cw": "arrow.clockwise",
  "rotate-ccw": "arrow.counterclockwise",
  "refresh-cw": "arrow.clockwise",
  power: "power",
  "power-off": "power",
  "arrow-up-down": "arrow.up.arrow.down",
  "circle-check": "checkmark.circle",
  list: "list.bullet",
  "layout-grid": "square.grid.2x2",
  settings: "gearshape",
  send: "paperplane",
  "flask-conical": "flask",
  info: "info.circle",
  star: "star",
  tag: "tag",
  calendar: "calendar",
  flag: "flag",
  house: "house",
  image: "photo",
  camera: "camera",
  "folder-open": "folder",
  "corner-left-up": "arrow.turn.left.up",
  "panel-right-open": "sidebar.right",
  "user-round": "person.crop.circle",
  minus: "minus",
  circle: "circle",
  "circle-dashed": "circle.dashed",
  "circle-dot": "circle.inset.filled",
  "circle-x": "xmark.circle",
  contrast: "circle.lefthalf.filled",
  "octagon-alert": "exclamationmark.octagon",
  "signal-high": "cellularbars",
  "signal-medium": "cellularbars",
  "signal-low": "cellularbars",
  "chevron-up": "chevron.up",
  "chevron-down": "chevron.down",
};
const symbol = (icon?: string) => (icon ? symbols[icon] : undefined);

/** A menu's entries in their groups: a line or a group's name starts the next. */
function groups(entries: MenuEntry[]) {
  const all: { title?: string; items: MenuItem[] }[] = [{ items: [] }];
  for (const entry of entries)
    if ("divider" in entry) all.push({ items: [] });
    else if ("section" in entry) all.push({ title: entry.section, items: [] });
    else all[all.length - 1]!.items.push(entry);
  return all.filter((group) => group.items.length);
}

/** What a row opens instead of doing something: its submenu, or where files are picked from. */
const submenu = (item: MenuItem) =>
  item.onFiles ? fileSources(Boolean(item.multiple), item.onFiles) : item.items;

/** The entries as iOS draws a menu: its groups, submenus, a check by the choice made. */
function NativeEntries({ entries }: { entries: MenuEntry[] }) {
  return groups(entries).map((group, i) => (
    <NativeSection key={i} title={group.title}>
      {group.items.map((item) => {
        const off = item.disabled ? [disabled()] : undefined;
        const opens = submenu(item);
        return opens ? (
          <NativeMenu
            key={item.title}
            label={item.title}
            systemImage={symbol(item.icon)}
            modifiers={off}
          >
            <NativeEntries entries={opens} />
          </NativeMenu>
        ) : item.checked !== undefined ? (
          <Toggle
            key={item.title}
            label={item.title}
            systemImage={symbol(item.icon)}
            isOn={item.checked}
            onIsOnChange={() => item.onPress?.()}
            modifiers={off}
          />
        ) : (
          <NativeButton
            key={item.title}
            label={item.title}
            systemImage={symbol(item.icon)}
            role={item.tone === "danger" ? "destructive" : undefined}
            onPress={() => item.onPress?.()}
            modifiers={off}
          />
        );
      })}
    </NativeSection>
  ));
}

/** Android's sheet of a menu, from the bottom: its groups, and a submenu in its place. */
function ActionSheet({
  entries,
  onClose,
}: {
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const { bottom } = useSafeAreaInsets();
  const ink = String(useCSSVariable("--color-foreground"));
  const faint = String(useCSSVariable("--color-faint"));
  const [trail, setTrail] = useState<{ title: string; items: MenuEntry[] }[]>(
    [],
  );
  const open = trail[trail.length - 1];
  const up = () => setTrail(trail.slice(0, -1));
  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={open ? up : onClose}
    >
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        className="flex-1 justify-end bg-black/40"
      >
        <Pressable
          className="rounded-t-2xl bg-card pt-2"
          style={{ paddingBottom: bottom + 8 }}
        >
          {open ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={up}
              className="min-h-12 flex-row items-center gap-2 border-b border-border px-4 active:bg-accent"
            >
              <ChevronLeftIcon color={ink} size={20} strokeWidth={1.5} />
              <Text className="text-base font-semibold">{open.title}</Text>
            </Pressable>
          ) : null}
          {groups(open?.items ?? entries).map((group, i) => (
            <View
              key={i}
              className={cn(i > 0 && "mt-1 border-t border-border pt-1")}
            >
              {group.title ? (
                <Text className="px-5 pt-2 pb-1 font-mono text-[11px] tracking-wider text-faint uppercase">
                  {group.title}
                </Text>
              ) : null}
              {group.items.map((item) => (
                <Pressable
                  key={item.title}
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: item.disabled,
                    checked: item.checked,
                  }}
                  disabled={item.disabled}
                  onPress={() => {
                    const opens = submenu(item);
                    if (opens)
                      return setTrail([...trail, { ...item, items: opens }]);
                    onClose();
                    item.onPress?.();
                  }}
                  className={cn(
                    "min-h-12 flex-row items-center gap-3 px-5 active:bg-accent",
                    item.disabled && "opacity-40",
                  )}
                >
                  {item.icon ? (
                    <Icon
                      name={item.icon}
                      tone={item.tone === "danger" ? "danger" : "default"}
                    />
                  ) : null}
                  <Text
                    className={cn(
                      "flex-1 text-base",
                      item.tone === "danger" && "text-destructive",
                    )}
                  >
                    {item.title}
                  </Text>
                  {item.checked ? (
                    <CheckIcon color={ink} size={18} strokeWidth={1.75} />
                  ) : submenu(item) ? (
                    <ChevronRightIcon
                      color={faint}
                      size={18}
                      strokeWidth={1.5}
                    />
                  ) : null}
                </Pressable>
              ))}
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            className="mt-1 min-h-12 justify-center border-t border-border px-5 active:bg-accent"
          >
            <Text className="text-base font-medium">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The entries as the children of expo-router's `Link.Menu`, the system's menu over a link's
 * preview: its groups inline, submenus, a check by the choice made.
 */
export const linkEntries = (entries: MenuEntry[]): ReactElement[] =>
  groups(entries).map((group, i) => (
    <Link.Menu key={i} title={group.title ?? ""} displayInline>
      {group.items.map((item) => {
        const opens = submenu(item);
        return opens ? (
          <Link.Menu
            key={item.title}
            title={item.title}
            icon={symbol(item.icon)}
          >
            {linkEntries(opens)}
          </Link.Menu>
        ) : (
          <Link.MenuAction
            key={item.title}
            icon={symbol(item.icon)}
            isOn={item.checked}
            destructive={item.tone === "danger"}
            disabled={item.disabled}
            onPress={() => item.onPress?.()}
          >
            {item.title}
          </Link.MenuAction>
        );
      })}
    </Link.Menu>
  ));

/** The app's sheet of a menu: `sheet` goes in the tree. */
export function useSheet() {
  const [shown, setShown] = useState<MenuEntry[]>();
  return {
    open: (entries: MenuEntry[]) => {
      void Haptics.selectionAsync();
      setShown(entries);
    },
    sheet: shown ? (
      <ActionSheet entries={shown} onClose={() => setShown(undefined)} />
    ) : null,
  };
}

/**
 * A sheet of actions to show: iOS's own action sheet, or a sheet of the app's on Android.
 * `sheet` goes in the tree for Android's.
 */
export function useActionSheet() {
  const { open, sheet } = useSheet();
  const show = (items: MenuItem[]) => {
    if (Platform.OS !== "ios") return open(items);
    void Haptics.selectionAsync();
    const marked = (is: (item: MenuItem) => boolean) =>
      items.flatMap((item, index) => (is(item) ? [index] : []));
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...items.map((item) => item.title), "Cancel"],
        cancelButtonIndex: items.length,
        destructiveButtonIndex: marked((item) => item.tone === "danger"),
        disabledButtonIndices: marked((item) => Boolean(item.disabled)),
      },
      (index) => items[index]?.onPress?.(),
    );
  };
  return { show, sheet };
}

/** What can be done with something, behind one button: iOS's own menu, or the app's sheet. */
export function Menu({ label, icon = "ellipsis", items }: MenuProps) {
  const { resolved } = useTheme();
  const { open, sheet } = useSheet();
  if (Platform.OS === "ios")
    return (
      <Host matchContents colorScheme={resolved}>
        <NativeMenu
          label={label}
          systemImage={symbol(icon) ?? "ellipsis"}
          modifiers={[
            labelStyle("iconOnly"),
            foregroundStyle({ type: "hierarchical", style: "secondary" }),
            frame({ width: 40, height: 40 }),
          ]}
        >
          <NativeEntries entries={items} />
        </NativeMenu>
      </Host>
    );
  return (
    <>
      <IconButton icon={icon} label={label} onPress={() => open(items)} />
      {sheet}
    </>
  );
}

/**
 * Something with its actions a long press away: iOS's own context menu, lifting it over the
 * rest; on Android, the app's sheet. A tap stays its own.
 */
export function RowMenu({
  items,
  children,
}: {
  items?: MenuEntry[];
  children: ReactElement;
}) {
  const { resolved } = useTheme();
  const { open, sheet } = useSheet();
  if (!items?.length) return children;
  if (Platform.OS !== "ios")
    return (
      <>
        <Pressable onLongPress={() => open(items)} delayLongPress={350}>
          {children}
        </Pressable>
        {sheet}
      </>
    );
  return (
    <Host matchContents={{ vertical: true }} colorScheme={resolved}>
      <ContextMenu>
        <ContextMenu.Items>
          <NativeEntries entries={items} />
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>{children}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}

/**
 * One of the actions along a bar, its icon over its title, as iOS's toolbars hold them: one
 * with a submenu opens it.
 */
export function BarAction({
  item,
  off = false,
}: {
  item: MenuItem;
  /** Nothing to act on yet. */
  off?: boolean;
}) {
  const { resolved } = useTheme();
  const { open, sheet } = useSheet();
  const danger = item.tone === "danger";
  const blocked = off || item.disabled;
  const opens = submenu(item);
  if (Platform.OS === "ios") {
    const look = [
      buttonStyle("plain"),
      foregroundStyle(
        blocked
          ? { type: "hierarchical", style: "tertiary" }
          : danger
            ? "red"
            : { type: "hierarchical", style: "primary" },
      ),
      frame({ minWidth: 64 }),
      ...(blocked ? [disabled()] : []),
    ];
    const label = (
      <VStack spacing={4}>
        <NativeImage
          systemName={symbol(item.icon) ?? "ellipsis"}
          size={20}
          modifiers={[frame({ height: 26 })]}
        />
        <NativeText modifiers={[font({ size: 11 })]}>{item.title}</NativeText>
      </VStack>
    );
    return (
      <Host matchContents colorScheme={resolved}>
        {opens ? (
          <NativeMenu label={label} modifiers={look}>
            <NativeEntries entries={opens} />
          </NativeMenu>
        ) : (
          <NativeButton onPress={() => item.onPress?.()} modifiers={look}>
            {label}
          </NativeButton>
        )}
      </Host>
    );
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: blocked }}
        disabled={blocked}
        onPress={() => (opens ? open(opens) : item.onPress?.())}
        className={cn(
          "min-w-16 items-center gap-1 py-1.5 active:opacity-60",
          blocked && "opacity-40",
        )}
      >
        <Icon
          name={item.icon ?? "ellipsis"}
          tone={danger ? "danger" : "default"}
        />
        <Text className={cn("text-[11px]", danger && "text-destructive")}>
          {item.title}
        </Text>
      </Pressable>
      {sheet}
    </>
  );
}
