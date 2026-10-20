import { createContext, useContext } from "react";
import { icons, PuzzleIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Actor } from "@zerolux/chat";
import type { Tone, UiComponents } from "@zerolux/ui";
import { cn } from "cn";
import { MessageText } from "@/components/message-text";
import { ActorMark } from "@/components/presence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

/** A Lucide icon by its name, as `kanban` or `file-text`; one this app lacks shows as a puzzle. */
export function lucideIcon(name?: string): LucideIcon {
  const pascal = name
    ?.split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return (pascal && icons[pascal as keyof typeof icons]) || PuzzleIcon;
}

/** The workspace's people and agents, for the avatars extensions' views show. */
export const UiActors = createContext<Actor[]>([]);

const tones: Record<Tone, string> = {
  default: "",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-attention",
  danger: "text-destructive",
};

/** A field's label above it, when it has one. */
function Labelled({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  if (!label) return children;
  return (
    <Field className="gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </Field>
  );
}

/** `@zerolux/ui`'s components, drawn with this app's. */
export const uiComponents: UiComponents = {
  Stack: ({ direction = "column", gap = 12, align, children }) => (
    <div
      className={cn(
        "flex min-w-0",
        direction === "row" ? "flex-row flex-wrap" : "flex-col",
        align === "start" && "items-start",
        align === "center" && "items-center",
        align === "end" && "items-end",
        align === "stretch" && "items-stretch",
      )}
      style={{ gap }}
    >
      {children}
    </div>
  ),
  Text: ({ tone = "default", size = "md", mono, children }) => (
    <p
      className={cn(
        size === "sm" ? "text-xs" : "text-sm",
        mono && "font-mono",
        tones[tone],
      )}
    >
      {children}
    </p>
  ),
  Heading: ({ level = 2, children }) => {
    const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
    return (
      <Tag
        className={cn(
          "font-semibold tracking-tight",
          level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm",
        )}
      >
        {children}
      </Tag>
    );
  },
  Markdown: ({ children }) => <MessageText text={children} />,
  Button: ({ title, onPress, variant = "secondary", disabled, busy }) => (
    <Button
      size="sm"
      variant={
        variant === "primary"
          ? "default"
          : variant === "danger"
            ? "destructive"
            : variant === "ghost"
              ? "ghost"
              : "outline"
      }
      disabled={disabled || busy}
      onClick={onPress}
      className="self-start"
    >
      {busy && <Spinner data-icon="inline-start" />}
      {title}
    </Button>
  ),
  IconButton: ({ icon, label, onPress, disabled }) => {
    const Drawn = lucideIcon(icon);
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onPress}
      >
        <Drawn />
      </Button>
    );
  },
  Icon: ({ name, size = 16, tone = "default" }) => {
    const Drawn = lucideIcon(name);
    return (
      <Drawn aria-hidden size={size} className={cn("shrink-0", tones[tone])} />
    );
  },
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
    <Labelled label={label}>
      {multiline ? (
        <Textarea
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          value={value}
          type={secure ? "password" : "text"}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              onSubmit
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
    </Labelled>
  ),
  Select: ({ value, options, onChange, label, placeholder, disabled }) => (
    <Labelled label={label}>
      <NativeSelect
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder && (
          <NativeSelectOption value="" disabled>
            {placeholder}
          </NativeSelectOption>
        )}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Labelled>
  ),
  Switch: ({ value, onChange, label, disabled }) => (
    <label className="flex items-center gap-2 text-sm">
      <Switch
        checked={value}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
      />
      {label}
    </label>
  ),
  List: ({ children }) => (
    <ul className="flex flex-col divide-y rounded-md border">{children}</ul>
  ),
  ListItem: ({ title, subtitle, leading, accessory, onPress }) => {
    const body = (
      <>
        {leading}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{title}</span>
          {subtitle && (
            <span className="truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          )}
        </span>
        {accessory}
      </>
    );
    return (
      <li>
        {onPress ? (
          <button
            type="button"
            onClick={onPress}
            className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent"
          >
            {body}
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2">{body}</div>
        )}
      </li>
    );
  },
  Table: ({ columns, rows }) => (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 font-medium">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2">
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  Badge: ({ tone = "default", children }) => (
    <Badge variant="outline" className={cn("shrink-0", tones[tone])}>
      {children}
    </Badge>
  ),
  Divider: () => <Separator />,
  Empty: ({ children }) => (
    <p className="text-sm text-muted-foreground">{children}</p>
  ),
  // Only what the view carries: nothing loads from elsewhere.
  Image: ({ src, alt, height }) =>
    src.startsWith("data:image/") ? (
      <img
        src={src}
        alt={alt}
        style={height ? { height } : undefined}
        className="max-h-80 max-w-full rounded-md border object-contain"
      />
    ) : null,
  Card: ({ title, children }) => (
    <Card size="sm">
      {title && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  ),
  Tabs: ({ items, value, onChange }) => (
    <Tabs value={value} onValueChange={(next) => onChange(String(next))}>
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  ),
  // A dialog here; a sheet on a phone.
  Sheet: ({ open, onClose, title, children }) => (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">{children}</div>
      </DialogContent>
    </Dialog>
  ),
  Spinner: ({ size = "md" }) => (
    <Spinner className={size === "sm" ? "size-3" : "size-4"} />
  ),
  Avatar: function Avatar({ actorId, size = "md" }) {
    const actor = useContext(UiActors).find((one) => one.id === actorId);
    return (
      <ActorMark
        kind={actor?.kind === "human" ? "human" : "agent"}
        name={actor?.name ?? "?"}
        className={size === "sm" ? "size-6 text-[10px]" : undefined}
      />
    );
  },
};
