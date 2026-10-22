import * as Haptics from "expo-haptics";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react-native";
import { Children, Fragment, isValidElement, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Image as NativeImage,
  Modal,
  Pressable,
  ScrollView,
  Switch as NativeSwitch,
  useWindowDimensions,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import type {
  ButtonProps,
  FileButtonProps,
  MenuEntry,
  MenuItem,
  MenuProps,
  Tone,
  UiComponents,
} from "@zerolux/ui";
import { Menu, RowMenu, useActionSheet } from "@/components/action-menu";
import { DateInput } from "@/components/date-input";
import { FolderInput } from "@/components/folder-input";
import { ActorMark } from "@/components/member";
import { MessageBody } from "@/components/message-body";
import { Segmented } from "@/components/segmented";
import { SettingSelect } from "@/components/setting-select";
import { Button as AppButton } from "@/components/ui/button";
import { Input as AppInput } from "@/components/ui/input";
import { Text as AppText } from "@/components/ui/text";
import { Icon, IconButton } from "@/components/ui-icon";
import { fileSources } from "@/components/pick-files";
import { SearchField } from "@/components/search-field";
import { Choosing, Table } from "@/components/ui-table";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";

const textTone: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};
const badgeTone: Record<Tone, string> = {
  default: "bg-muted",
  muted: "bg-muted",
  success: "bg-success/15",
  warning: "bg-warning/15",
  danger: "bg-destructive/15",
};
/** Columns as wide as most of the screen, so the next one shows at its edge. */
const COLUMN = 0.8;

/**
 * As wide as what it holds, in a column or a row alike: a row of its own keeps it from
 * stretching across a column, and leaves a row's alignment to the row.
 */
function Fit({ children }: { children: ReactNode }) {
  return <View className="flex-row">{children}</View>;
}

const Button: UiComponents["Button"] = ({
  title,
  onPress,
  variant = "primary",
  disabled,
  busy,
}) => (
  <Fit>
    <AppButton
      variant={
        variant === "danger"
          ? "destructive"
          : variant === "secondary"
            ? "outline"
            : variant === "ghost"
              ? "ghost"
              : "default"
      }
      disabled={disabled || busy}
      onPress={onPress}
    >
      {busy ? <ActivityIndicator size="small" /> : null}
      <AppText>{title}</AppText>
    </AppButton>
  </Fit>
);

const Tabs: UiComponents["Tabs"] = ({ items, value, onChange }) => (
  <Segmented
    options={items.map((item) => [item.value, item.label])}
    value={value}
    choose={onChange}
  />
);

const Sheet: UiComponents["Sheet"] = ({ open, onClose, title, children }) => (
  <Modal
    visible={open}
    animationType="slide"
    presentationStyle="pageSheet"
    onRequestClose={onClose}
  >
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <AppText className="text-[17px] font-semibold">{title}</AppText>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
          <AppText className="text-base font-medium text-human-foreground">
            Done
          </AppText>
        </Pressable>
      </View>
      <ScrollView
        contentContainerClassName="gap-4 px-5 py-5"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  </Modal>
);

/** Groups of a menu, a line between them; empty ones go. */
const joined = (...groups: MenuEntry[][]) =>
  groups
    .filter((group) => group.length)
    .flatMap((group, i) =>
      i ? [{ divider: true } as MenuEntry, ...group] : group,
    );

const FileButton: UiComponents["FileButton"] = ({
  title,
  onFiles,
  multiple = false,
  variant = "secondary",
  busy,
  disabled,
}) => {
  const { show, sheet } = useActionSheet();
  return (
    <>
      <Button
        title={title}
        variant={variant}
        busy={busy}
        disabled={disabled}
        onPress={() => show(fileSources(multiple, onFiles))}
      />
      {sheet}
    </>
  );
};

/** Parts as they are, a fragment's own among them. */
const flat = (node: ReactNode): ReactNode[] =>
  Children.toArray(node).flatMap((part) =>
    isValidElement<{ children?: ReactNode }>(part) && part.type === Fragment
      ? flat(part.props.children)
      : [part],
  );

/**
 * A page's header sorted for a phone: its views on a line of their own; beside the title its
 * icons and its main action; the other buttons, its "…" menus and the page's own menu under
 * one "…".
 */
function headerParts(actions: ReactNode, menu: MenuEntry[] = []) {
  const tabs: ReactNode[] = [];
  const shown: ReactNode[] = [];
  const folded: MenuItem[] = [];
  const menus: MenuEntry[] = [];
  for (const part of flat(actions)) {
    if (!isValidElement(part)) shown.push(part);
    else if (part.type === Tabs) tabs.push(part);
    else if (part.type === Menu) {
      const { icon = "ellipsis", items } = part.props as MenuProps;
      if (icon === "ellipsis") menus.push(...items);
      else shown.push(part);
    } else if (part.type === Button || part.type === FileButton) {
      const props = part.props as Partial<ButtonProps & FileButtonProps>;
      const variant =
        props.variant ?? (part.type === Button ? "primary" : "secondary");
      if (variant === "primary" && !shown.some(isMain)) shown.push(part);
      else
        folded.push({
          title: props.title ?? "",
          onPress: props.onPress,
          onFiles: props.onFiles,
          multiple: props.multiple,
          disabled: props.disabled || props.busy,
          tone: variant === "danger" ? "danger" : undefined,
        });
    } else shown.push(part);
  }
  // What the page's menu already has is not said twice.
  const titles = new Set(menu.map((entry) => "title" in entry && entry.title));
  return {
    tabs,
    shown,
    more: joined(
      menu,
      folded.filter((item) => !titles.has(item.title)),
      menus,
    ),
  };
}

/** The page's main action, beside its title. */
const isMain = (part: ReactNode) =>
  isValidElement(part) && (part.type === Button || part.type === FileButton);

/**
 * `@zerolux/ui`'s components on the phone, in the app's own design: what an extension's
 * native view draws with.
 */
export const uiComponents: UiComponents = {
  Stack: ({ direction = "column", gap = 12, align, children }) => (
    <View
      style={{
        flexDirection: direction,
        gap,
        alignItems:
          align === "start"
            ? "flex-start"
            : align === "end"
              ? "flex-end"
              : align === "center"
                ? "center"
                : direction === "row"
                  ? "center"
                  : "stretch",
      }}
    >
      {children}
    </View>
  ),
  Text: ({ tone = "default", size = "md", mono = false, children }) => (
    <AppText
      className={cn(
        size === "sm"
          ? "text-[13px] leading-[19px]"
          : "text-[15px] leading-[22px]",
        mono && "font-mono",
        textTone[tone],
      )}
    >
      {children}
    </AppText>
  ),
  Heading: ({ level = 2, children }) => (
    <AppText
      accessibilityRole="header"
      className={cn(
        "font-semibold",
        level === 1 ? "text-xl" : level === 2 ? "text-lg" : "text-base",
      )}
    >
      {children}
    </AppText>
  ),
  Markdown: ({ children }) => <MessageBody text={children} />,
  Button,
  IconButton,
  Icon,
  Input: ({
    value,
    onChange,
    label,
    placeholder,
    multiline,
    secure,
    disabled,
    autoFocus,
    onSubmit,
  }) => (
    <View className="flex-1 gap-1.5">
      {label ? (
        <AppText className="text-sm font-medium">{label}</AppText>
      ) : null}
      <AppInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        accessibilityLabel={label ?? placeholder}
        multiline={multiline}
        secureTextEntry={secure}
        editable={!disabled}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmit}
        className={multiline ? "h-auto min-h-20 py-2" : undefined}
      />
    </View>
  ),
  Select: ({ value, options, onChange, label, placeholder, disabled }) => (
    <SettingSelect
      label={label ?? ""}
      value={value}
      options={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
    />
  ),
  Switch: ({ value, onChange, label, disabled }) => (
    <View className="flex-row items-center justify-between gap-3">
      {label ? <AppText className="flex-1 text-[15px]">{label}</AppText> : null}
      <NativeSwitch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  ),
  List: ({ children }) => (
    <View className="overflow-hidden rounded-md border border-border bg-card">
      {Children.toArray(children).map((row, i) => (
        <View key={i} className={cn(i > 0 && "border-t border-border")}>
          {row}
        </View>
      ))}
    </View>
  ),
  ListItem: function ListItem({
    title,
    subtitle,
    leading,
    accessory,
    onPress,
    selected,
    menu,
  }) {
    const faint = String(useCSSVariable("--color-faint"));
    const body = (
      <>
        {leading}
        <View className="min-w-0 flex-1 gap-0.5">
          <AppText numberOfLines={2} className="text-[15px]">
            {title}
          </AppText>
          {subtitle ? (
            <AppText
              numberOfLines={2}
              className="text-[13px] text-muted-foreground"
            >
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {accessory}
        {onPress ? (
          <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
        ) : null}
      </>
    );
    const row = cn(
      "min-h-12 flex-row items-center gap-3 px-3.5 py-2.5",
      selected && "bg-accent",
    );
    return (
      <RowMenu items={menu}>
        {onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              void Haptics.selectionAsync();
              onPress();
            }}
            className={cn(row, "bg-card active:bg-accent")}
          >
            {body}
          </Pressable>
        ) : (
          <View className={cn(row, "bg-card")}>{body}</View>
        )}
      </RowMenu>
    );
  },
  Table,
  Badge: ({ tone = "default", children }) => (
    <Fit>
      <View className={cn("rounded-sm px-2 py-0.5", badgeTone[tone])}>
        <AppText
          className={cn(
            "font-mono text-[11px]",
            tone === "default" ? "text-muted-foreground" : textTone[tone],
          )}
        >
          {children}
        </AppText>
      </View>
    </Fit>
  ),
  Divider: () => <View className="h-px bg-border" />,
  Empty: ({ children }) => (
    <AppText className="py-6 text-center text-sm text-faint">
      {children}
    </AppText>
  ),
  // Carried in the view itself: nothing loads from outside.
  Image: ({ src, alt, height = 192 }) =>
    src.startsWith("data:image/") ? (
      <NativeImage
        source={{ uri: src }}
        accessibilityLabel={alt}
        resizeMode="contain"
        style={{ height }}
        className="w-full rounded-md bg-muted"
      />
    ) : null,
  // Its menu a long press away, and by its title as a "…" when it has one.
  Card: ({ title, onPress, selected, menu, children }) => {
    const body = (
      <>
        {title ? (
          <View className="flex-row items-center gap-2">
            <AppText className="flex-1 text-[15px] font-semibold">
              {title}
            </AppText>
            {menu?.length ? (
              <View className="-my-2.5 -mr-2.5">
                <Menu label="More" items={menu} />
              </View>
            ) : null}
          </View>
        ) : null}
        {children}
      </>
    );
    const card = cn(
      "gap-3 rounded-md border bg-card p-4",
      selected ? "border-primary bg-accent" : "border-border",
    );
    return (
      <RowMenu items={menu}>
        {onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              void Haptics.selectionAsync();
              onPress();
            }}
            className={cn(card, "active:bg-accent")}
          >
            {body}
          </Pressable>
        ) : (
          <View className={card}>{body}</View>
        )}
      </RowMenu>
    );
  },
  Columns: function Columns({ children }) {
    const width = Math.min(useWindowDimensions().width * COLUMN, 340);
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={width + 12}
        decelerationRate="fast"
        contentContainerClassName="items-start gap-3"
      >
        {Children.toArray(children).map((column, i) => (
          <View key={i} style={{ width }}>
            {column}
          </View>
        ))}
      </ScrollView>
    );
  },
  // One at a time on a phone: the list, or what is open in it with the way back to the list.
  Split: function Split({ label, actions, list, detail, open, onBack }) {
    const ink = String(useCSSVariable("--color-foreground"));
    if (!open)
      return (
        <View className="gap-3">
          <View className="min-h-10 flex-row items-center justify-between gap-2">
            <AppText
              accessibilityRole="header"
              className="text-lg font-semibold"
            >
              {label}
            </AppText>
            {actions ? (
              <View className="-mr-2 flex-row items-center">{actions}</View>
            ) : null}
          </View>
          {list}
        </View>
      );
    return (
      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onBack}
          hitSlop={8}
          className="flex-row items-center gap-1 self-start active:opacity-60"
        >
          <ChevronLeftIcon color={ink} size={18} strokeWidth={1.75} />
          <AppText className="text-sm font-medium">{label}</AppText>
        </Pressable>
        {detail}
      </View>
    );
  },
  Section: ({ title, actions, children }) => (
    <View className="gap-2">
      <View className="min-h-10 flex-row items-center justify-between gap-2">
        <AppText
          accessibilityRole="header"
          className="font-mono text-[11px] tracking-wider text-faint uppercase"
        >
          {title}
        </AppText>
        {actions ? (
          <View className="-mr-2 flex-row items-center">{actions}</View>
        ) : null}
      </View>
      {children}
    </View>
  ),
  // The title large and the way to it under it; beside it what it does, the rest in its "…";
  // what is open in it comes up as a sheet.
  Page: function Page({
    title,
    subtitle,
    search,
    actions,
    inspector,
    menu,
    children,
  }) {
    const faint = String(useCSSVariable("--color-faint"));
    const [choosing, setChoosing] = useState(false);
    const crumbs = typeof title === "string" ? [] : title;
    const { tabs, shown, more } = headerParts(actions, menu);
    return (
      <View className="gap-3">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <AppText
              accessibilityRole="header"
              className="text-[28px] font-semibold tracking-tight"
            >
              {typeof title === "string" ? title : title.at(-1)?.title}
            </AppText>
            {crumbs.length > 1 ? (
              <View className="flex-row flex-wrap items-center gap-1">
                {crumbs.map((crumb, i) => (
                  <View key={i} className="flex-row items-center gap-1">
                    {i ? (
                      <ChevronRightIcon
                        color={faint}
                        size={13}
                        strokeWidth={1.5}
                      />
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      disabled={!crumb.onPress || i === crumbs.length - 1}
                      onPress={crumb.onPress}
                      hitSlop={6}
                      className="active:opacity-60"
                    >
                      <AppText className="text-[13px] text-muted-foreground">
                        {crumb.title}
                      </AppText>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            {subtitle ? (
              <AppText className="text-[13px] text-muted-foreground">
                {subtitle}
              </AppText>
            ) : null}
          </View>
          {shown.length || more.length ? (
            <View className="-mr-2 flex-row items-center gap-1 pt-0.5">
              {shown}
              {more.length ? <Menu label="More" items={more} /> : null}
            </View>
          ) : null}
        </View>
        {tabs}
        {search ? (
          <SearchField
            value={search.value}
            onChange={search.onChange}
            label={search.placeholder}
          />
        ) : null}
        <Choosing.Provider value={setChoosing}>{children}</Choosing.Provider>
        {inspector && !choosing ? (
          <Sheet open title={inspector.title} onClose={inspector.onClose}>
            {inspector.content}
          </Sheet>
        ) : null}
      </View>
    );
  },
  FolderInput,
  DateInput,
  Menu,
  FileButton,
  // Nothing is dragged onto a phone's view.
  DropZone: ({ children }) => <>{children}</>,
  Tabs,
  Sheet,
  Spinner: function Spinner({ size = "md" }) {
    const muted = String(useCSSVariable("--color-muted-foreground"));
    return (
      <Fit>
        <ActivityIndicator
          size={size === "sm" ? "small" : "large"}
          color={muted}
        />
      </Fit>
    );
  },
  Avatar: function Avatar({ actorId, size = "md" }) {
    const { actors } = useSession();
    const actor = actors.find((a) => a.id === actorId);
    return (
      <ActorMark
        kind={actor?.kind === "human" ? "human" : "agent"}
        name={actor?.name ?? "?"}
        size={size}
      />
    );
  },
};
