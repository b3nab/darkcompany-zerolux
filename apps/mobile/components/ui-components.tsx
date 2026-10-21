import * as Haptics from "expo-haptics";
import { ChevronRightIcon } from "lucide-react-native";
import { Children } from "react";
import {
  ActivityIndicator,
  Alert,
  Image as NativeImage,
  Modal,
  Pressable,
  ScrollView,
  Switch as NativeSwitch,
  useWindowDimensions,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage } from "@zerolux/chat";
import type { Tone, UiComponents } from "@zerolux/ui";
import { Menu, useActionSheet } from "@/components/action-menu";
import { DateInput } from "@/components/date-input";
import { ActorMark } from "@/components/member";
import { MessageBody } from "@/components/message-body";
import { Segmented } from "@/components/segmented";
import { SettingSelect } from "@/components/setting-select";
import { Button as AppButton } from "@/components/ui/button";
import { Input as AppInput } from "@/components/ui/input";
import { Text as AppText } from "@/components/ui/text";
import { Icon, IconButton } from "@/components/ui-icon";
import { pickFiles } from "@/components/pick-files";
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

const Button: UiComponents["Button"] = ({
  title,
  onPress,
  variant = "primary",
  disabled,
  busy,
}) => (
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
    className="self-start"
  >
    {busy ? <ActivityIndicator size="small" /> : null}
    <AppText>{title}</AppText>
  </AppButton>
);

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
    const row = "min-h-12 flex-row items-center gap-3 px-3.5 py-2.5";
    return onPress ? (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void Haptics.selectionAsync();
          onPress();
        }}
        className={cn(row, "active:bg-accent")}
      >
        {body}
      </Pressable>
    ) : (
      <View className={row}>{body}</View>
    );
  },
  Table: ({ columns, rows }) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="overflow-hidden rounded-md border border-border bg-card">
        <View className="flex-row border-b border-border bg-muted">
          {columns.map((column) => (
            <AppText
              key={column.key}
              className="w-32 px-3 py-2 font-mono text-[11px] tracking-wider text-faint uppercase"
            >
              {column.title}
            </AppText>
          ))}
        </View>
        {rows.map((row, i) => (
          <View
            key={i}
            className={cn("flex-row", i > 0 && "border-t border-border")}
          >
            {columns.map((column) => (
              <View key={column.key} className="w-32 px-3 py-2">
                {typeof row[column.key] === "string" ||
                typeof row[column.key] === "number" ? (
                  <AppText className="text-sm">{row[column.key]}</AppText>
                ) : (
                  row[column.key]
                )}
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  ),
  Badge: ({ tone = "default", children }) => (
    <View className={cn("self-start rounded-sm px-2 py-0.5", badgeTone[tone])}>
      <AppText
        className={cn(
          "font-mono text-[11px]",
          tone === "default" ? "text-muted-foreground" : textTone[tone],
        )}
      >
        {children}
      </AppText>
    </View>
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
  Card: ({ title, onPress, children }) => {
    const body = (
      <>
        {title ? (
          <AppText className="text-[15px] font-semibold">{title}</AppText>
        ) : null}
        {children}
      </>
    );
    const card = "gap-3 rounded-md border border-border bg-card p-4";
    return onPress ? (
      <Pressable
        accessibilityRole="button"
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
  DateInput,
  Menu,
  FileButton: function FileButton({
    title,
    onFiles,
    multiple = false,
    variant = "secondary",
    busy,
    disabled,
  }) {
    const { show, sheet } = useActionSheet();
    const pick = (from: "library" | "camera" | "files") =>
      pickFiles(from, multiple).then(
        (files) => files.length && onFiles(files),
        (e: unknown) => Alert.alert(errorMessage(e)),
      );
    return (
      <>
        <Button
          title={title}
          variant={variant}
          busy={busy}
          disabled={disabled}
          onPress={() =>
            show([
              { title: "Photo library", onPress: () => void pick("library") },
              { title: "Take photo", onPress: () => void pick("camera") },
              { title: "Files", onPress: () => void pick("files") },
            ])
          }
        />
        {sheet}
      </>
    );
  },
  // Nothing is dragged onto a phone's view.
  DropZone: ({ children }) => <>{children}</>,
  Tabs: ({ items, value, onChange }) => (
    <Segmented
      options={items.map((item) => [item.value, item.label])}
      value={value}
      choose={onChange}
    />
  ),
  Sheet: ({ open, onClose, title, children }) => (
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
  ),
  Spinner: function Spinner({ size = "md" }) {
    const muted = String(useCSSVariable("--color-muted-foreground"));
    return (
      <ActivityIndicator
        size={size === "sm" ? "small" : "large"}
        color={muted}
        className="self-start"
      />
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
