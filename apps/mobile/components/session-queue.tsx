import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  PanResponder,
  Pressable,
  TextInput,
  View,
} from "react-native";
import type { TextInputInstance } from "react-native";
import * as Haptics from "expo-haptics";
import {
  ClockIcon,
  GripVerticalIcon,
  ImageIcon,
  XIcon,
} from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage } from "@zerolux/chat";
import type { ChatSession, QueueItem, QueuedInput } from "@zerolux/chat";
import type { MenuEntry } from "@zerolux/ui";
import { RowMenu } from "@/components/action-menu";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";

/** Where a queued input is in its queue, to move it there or elsewhere. */
interface Place {
  index: number;
  count: number;
  /** Puts it at this index. */
  move: (to: number) => void;
  /** Puts it where it was dropped, `dy` from where it was. */
  drop: (dy: number) => void;
  layout: (y: number, height: number) => void;
}

/**
 * The inputs waiting in the session's queue, above the box, the next one first: each one moves
 * by its grip, goes with its ✕, and is edited or sent now from a long press. Clear all empties
 * the queue.
 */
export function QueueStack({
  session,
  items,
  write,
}: {
  session: ChatSession;
  items: QueueItem[];
  write: boolean;
}) {
  const { chat } = useSession();
  // The order dropped, shown until the queue read again has it.
  const [order, setOrder] = useState<string[]>();
  const [error, setError] = useState("");
  const places = useRef(new Map<string, { y: number; height: number }>());
  const rank = (id: string) => {
    const at = order?.indexOf(id) ?? -1;
    return at < 0 ? Infinity : at;
  };
  const shown = order
    ? [...items].sort((a, b) => rank(a.id) - rank(b.id))
    : items;
  const move = (id: string, to: number) => {
    const ids = shown.map((item) => item.id).filter((each) => each !== id);
    ids.splice(to, 0, id);
    if (ids.every((each, i) => each === shown[i]?.id)) return;
    setOrder(ids);
    setError("");
    chat
      .reorderQueue(session.id, ids)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setOrder(undefined));
  };
  // Dropped, it goes before the first input whose middle is below its own.
  const drop = (id: string, dy: number) => {
    const from = places.current.get(id);
    if (!from) return;
    const middle = from.y + from.height / 2 + dy;
    const above = shown.filter((item) => {
      const at = places.current.get(item.id);
      return item.id !== id && at && at.y + at.height / 2 < middle;
    });
    move(id, above.length);
  };
  const clear = () =>
    Alert.alert("Clear the queue?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear all",
        style: "destructive",
        onPress: () =>
          void chat
            .clearQueue(session.id)
            .catch((e: unknown) => setError(errorMessage(e))),
      },
    ]);
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between px-1.5">
        <Text className="font-mono text-[11px] tracking-wider text-faint uppercase">
          Queued · {shown.length}
        </Text>
        {write && shown.length > 1 ? (
          <Pressable
            onPress={clear}
            accessibilityRole="button"
            hitSlop={8}
            className="py-1.5"
          >
            <Text className="text-xs text-muted-foreground">Clear all</Text>
          </Pressable>
        ) : null}
      </View>
      {shown.map((item, index) => (
        <QueueCard
          key={item.id}
          session={session}
          item={item}
          queued
          changeable={write}
          place={
            write && shown.length > 1
              ? {
                  index,
                  count: shown.length,
                  move: (to) => move(item.id, to),
                  drop: (dy) => drop(item.id, dy),
                  layout: (y, height) =>
                    places.current.set(item.id, { y, height }),
                }
              : undefined
          }
        />
      ))}
      {error ? (
        <Text className="px-1.5 text-xs text-destructive">{error}</Text>
      ) : null}
    </View>
  );
}

/**
 * An input of the owner's waiting above the box: `queued`, it goes as a turn of its own when
 * the one before ends; else its harness takes it into the turn at its next step. Where it can
 * be, it is edited in place or taken out, and a queued one sent now.
 */
export function QueueCard({
  session,
  item,
  queued = false,
  changeable,
  place,
}: {
  session: ChatSession;
  item: QueueItem | QueuedInput;
  queued?: boolean;
  changeable: boolean;
  place?: Place;
}) {
  const { chat } = useSession();
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [faint, muted] = useCSSVariable([
    "--color-faint",
    "--color-muted-foreground",
  ]).map(String);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setEditing(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = () => void act(() => chat.removeQueued(session.id, item.id));
  // Opened from a menu, the box takes the keyboard once the menu has gone.
  const box = useRef<TextInputInstance>(null);
  const opened = editing !== undefined;
  useEffect(() => {
    if (!opened) return;
    const timer = setTimeout(() => box.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [opened]);
  const menu: MenuEntry[] | undefined =
    changeable && editing === undefined
      ? [
          {
            title: "Edit",
            icon: "pencil",
            onPress: () => setEditing(item.text),
          },
          ...(queued
            ? [
                {
                  title: "Send now",
                  icon: "send",
                  onPress: () =>
                    void act(() => chat.sendQueued(session.id, item.id)),
                },
              ]
            : []),
          { title: "Remove", icon: "x", tone: "danger", onPress: remove },
        ]
      : undefined;
  const images = "images" in item ? item.images.length : 0;
  // Lifted by its grip, it follows the finger until dropped.
  const dy = useRef(new Animated.Value(0)).current;
  const [lifted, setLifted] = useState(false);
  const latest = useRef(place);
  latest.current = place;
  const grip = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          setLifted(true);
          void Haptics.selectionAsync();
        },
        onPanResponderMove: Animated.event([null, { dy }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_, gesture) => {
          latest.current?.drop(gesture.dy);
          dy.setValue(0);
          setLifted(false);
        },
        onPanResponderTerminate: () => {
          dy.setValue(0);
          setLifted(false);
        },
      }),
    [dy],
  );
  return (
    <Animated.View
      onLayout={(event) =>
        place?.layout(
          event.nativeEvent.layout.y,
          event.nativeEvent.layout.height,
        )
      }
      style={{ transform: [{ translateY: dy }], zIndex: lifted ? 1 : 0 }}
    >
      <View className="flex-row items-start gap-1">
        {place ? (
          <View
            {...grip.panHandlers}
            accessible
            accessibilityLabel="Move"
            accessibilityActions={[
              ...(place.index > 0 ? [{ name: "up", label: "Move up" }] : []),
              ...(place.index < place.count - 1
                ? [{ name: "down", label: "Move down" }]
                : []),
            ]}
            onAccessibilityAction={({ nativeEvent }) =>
              place.move(
                place.index + (nativeEvent.actionName === "up" ? -1 : 1),
              )
            }
            className="w-5 items-center self-stretch justify-center"
          >
            <GripVerticalIcon color={faint} size={15} strokeWidth={1.75} />
          </View>
        ) : null}
        <View className="min-w-0 flex-1">
          <RowMenu items={menu}>
            <Pressable
              className={cn(
                "gap-2 rounded-md border border-border bg-background px-3 py-2",
                lifted && "border-ring opacity-90",
              )}
            >
              <View className="flex-row items-start gap-2">
                <View className="mt-1">
                  <ClockIcon color={faint} size={13} strokeWidth={1.75} />
                </View>
                {editing === undefined ? (
                  <View className="flex-1 gap-1">
                    <Text numberOfLines={3} className="text-sm">
                      {item.text}
                    </Text>
                    {images ? (
                      <View className="flex-row items-center gap-1">
                        <ImageIcon color={faint} size={12} strokeWidth={1.75} />
                        <Text className="font-mono text-[11px] text-faint">
                          {images}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : (
                  <TextInput
                    ref={box}
                    value={editing}
                    onChangeText={setEditing}
                    multiline
                    accessibilityLabel="Waiting input"
                    className="max-h-28 flex-1 font-sans text-sm text-foreground"
                  />
                )}
                {changeable && editing === undefined ? (
                  <Pressable
                    onPress={remove}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="Remove"
                    hitSlop={8}
                  >
                    <XIcon color={muted} size={15} strokeWidth={2} />
                  </Pressable>
                ) : null}
              </View>
              {editing !== undefined ? (
                <View className="flex-row justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onPress={() => setEditing(undefined)}
                  >
                    <Text>Cancel</Text>
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !editing.trim()}
                    onPress={() =>
                      void act(() =>
                        chat.editQueued(session.id, item.id, editing.trim()),
                      )
                    }
                  >
                    <Text>Save</Text>
                  </Button>
                </View>
              ) : null}
              {error ? (
                <Text className="text-xs text-destructive">{error}</Text>
              ) : null}
            </Pressable>
          </RowMenu>
        </View>
      </View>
    </Animated.View>
  );
}
