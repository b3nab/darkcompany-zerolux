import { Portal } from "@rn-primitives/portal";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { CheckIcon } from "lucide-react-native";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import type { MenuEntry, MenuItem, TableProps, TableRow } from "@zerolux/ui";
import { BarAction, Menu, RowMenu } from "@/components/action-menu";
import { Text } from "@/components/ui/text";
import { Icon } from "@/components/ui-icon";
import { cn } from "@/lib/utils";

/** How many actions the selection's bar holds before the rest go under More. */
const BAR = 4;
/** The icons view's tiles, at least this wide. */
const TILE = 104;

/**
 * Told by a table while its rows are being chosen: the page around it keeps what is open in
 * it out of the way until the choosing ends.
 */
export const Choosing = createContext<(on: boolean) => void>(() => {});

const isText = (value: ReactNode) =>
  typeof value === "string" || typeof value === "number";

/** A cell as text when it is text, else as it is. */
const cell = (value: ReactNode, className: string, lines = 1) =>
  isText(value) ? (
    <Text numberOfLines={lines} className={className}>
      {value}
    </Text>
  ) : (
    value
  );

/** A row's mark while choosing: a circle, filled and checked once chosen. */
function Check({ on }: { on: boolean }) {
  const ink = String(useCSSVariable("--color-primary-foreground"));
  return (
    <View
      className={cn(
        "size-[22px] items-center justify-center rounded-full border-[1.5px]",
        on ? "border-primary bg-primary" : "border-faint",
      )}
    >
      {on ? <CheckIcon color={ink} size={14} strokeWidth={2.5} /> : null}
    </View>
  );
}

/** A text button, as iOS's bars hold them. */
function Plain({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <Text className="text-[15px] font-medium text-human-foreground">
        {title}
      </Text>
    </Pressable>
  );
}

/**
 * Rows as a phone lists them: the first column names the row, numbers end it on the right,
 * the rest goes under the name; or as icons named by the first column. Select chooses rows
 * with taps, and what can be done with them stays along the bottom; a long press opens a
 * row's menu, or the selection's among chosen rows.
 */
export function Table({
  columns,
  rows,
  view = "list",
  selected = [],
  onSelect,
  selectionMenu,
  sort,
  onSort,
  empty,
}: TableProps) {
  const [selecting, setSelecting] = useState(false);
  const [width, setWidth] = useState(0);
  const tell = useContext(Choosing);
  useEffect(() => {
    tell(selecting);
    return () => tell(false);
  }, [selecting, tell]);
  const { bottom } = useSafeAreaInsets();
  const focused = useIsFocused();
  const bar = useId();
  const [first, ...rest] = columns;
  const chosen = new Set(selected);
  const all = rows.length > 0 && rows.every((row) => chosen.has(row.id));
  const press = (row: TableRow) => {
    if (!selecting) return row.onOpen?.();
    void Haptics.selectionAsync();
    onSelect?.(
      chosen.has(row.id)
        ? selected.filter((id) => id !== row.id)
        : [...selected, row.id],
    );
  };
  // Among chosen rows, a long press acts on all of them.
  const menuOf = (row: TableRow) =>
    selecting && chosen.has(row.id) && chosen.size > 1 && selectionMenu
      ? selectionMenu
      : row.menu;
  const sorting: MenuEntry[] = columns.map((column) => {
    const on = sort?.key === column.key;
    return {
      title: column.title,
      icon: on ? (sort?.descending ? "chevron-down" : "chevron-up") : undefined,
      checked: on,
      onPress: () =>
        onSort?.({
          key: column.key,
          descending: on ? !sort?.descending : false,
        }),
    };
  });
  const actions = (selectionMenu ?? []).filter(
    (entry): entry is MenuItem => "title" in entry,
  );
  // Past what the bar holds, the rest under More, in their groups.
  const kept = actions.slice(0, BAR - 1);
  const shown: MenuItem[] =
    actions.length > BAR
      ? [
          ...kept,
          {
            title: "More",
            icon: "ellipsis",
            items: (selectionMenu ?? []).filter(
              (entry) => !kept.includes(entry as MenuItem),
            ),
          },
        ]
      : actions;
  const across = Math.max(3, Math.floor((width + 12) / (TILE + 12)));
  const tile = width ? (width - 12 * (across - 1)) / across : TILE;
  if (!first) return null;
  return (
    <View className="gap-2">
      {onSort || onSelect ? (
        <View className="min-h-10 flex-row items-center justify-between gap-3">
          {selecting ? (
            <Plain
              title={all ? "Deselect all" : "Select all"}
              onPress={() => onSelect?.(all ? [] : rows.map((row) => row.id))}
            />
          ) : onSort ? (
            <Menu label="Sort" icon="arrow-up-down" items={sorting} />
          ) : (
            <View />
          )}
          {selecting ? (
            <Text className="text-[15px] font-semibold">
              {`${chosen.size} selected`}
            </Text>
          ) : null}
          {onSelect ? (
            <Plain
              title={selecting ? "Done" : "Select"}
              onPress={() => {
                void Haptics.selectionAsync();
                if (selecting) onSelect([]);
                setSelecting(!selecting);
              }}
            />
          ) : (
            <View />
          )}
        </View>
      ) : null}
      {!rows.length ? (
        empty ? (
          <Text className="py-6 text-center text-sm text-faint">{empty}</Text>
        ) : null
      ) : view === "icons" ? (
        <View
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          className="flex-row flex-wrap gap-3"
        >
          {rows.map((row) => (
            // The tile's width is its frame's: iOS's menu fills what holds it.
            <View key={row.id} style={{ width: tile }}>
              <RowMenu items={menuOf(row)}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen.has(row.id) }}
                  onPress={() => press(row)}
                  className="items-center gap-1.5 active:opacity-70"
                >
                  <View
                    className={cn(
                      "aspect-square w-full items-center justify-center rounded-xl border bg-muted",
                      chosen.has(row.id) ? "border-primary" : "border-border",
                    )}
                  >
                    <Icon name={row.icon ?? "file"} size={36} />
                    {selecting ? (
                      <View className="absolute right-1.5 bottom-1.5">
                        <Check on={chosen.has(row.id)} />
                      </View>
                    ) : null}
                  </View>
                  {cell(
                    row.cells[first.key],
                    "text-center text-[12.5px] font-medium",
                    2,
                  )}
                </Pressable>
              </RowMenu>
            </View>
          ))}
        </View>
      ) : (
        <View className="overflow-hidden rounded-md border border-border bg-card">
          {rows.map((row, i) => {
            const on = chosen.has(row.id);
            const under = rest
              .filter((column) => column.align !== "end")
              .map((column) => row.cells[column.key])
              .filter((value) => value != null && value !== "");
            const trailing = rest.filter((column) => column.align === "end");
            return (
              <RowMenu key={row.id} items={menuOf(row)}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={
                    selecting || row.onOpen ? () => press(row) : undefined
                  }
                  className={cn(
                    "min-h-12 flex-row items-center gap-3 bg-card px-3.5 py-2.5 active:bg-accent",
                    i > 0 && "border-t border-border",
                    on && !selecting && "bg-accent",
                  )}
                >
                  {selecting ? <Check on={on} /> : null}
                  <View className="min-w-0 flex-1 gap-0.5">
                    {cell(row.cells[first.key], "text-[15px]")}
                    {under.length && under.every(isText) ? (
                      <Text
                        numberOfLines={1}
                        className="text-[13px] text-muted-foreground"
                      >
                        {under.join(" · ")}
                      </Text>
                    ) : under.length ? (
                      <View className="flex-row flex-wrap items-center gap-1.5">
                        {under.map((value, n) => (
                          <Fragment key={n}>
                            {n ? (
                              <Text className="text-[13px] text-faint">·</Text>
                            ) : null}
                            {cell(value, "text-[13px] text-muted-foreground")}
                          </Fragment>
                        ))}
                      </View>
                    ) : null}
                  </View>
                  {trailing.length ? (
                    <View className="items-end gap-0.5">
                      {trailing.map((column) => (
                        <Fragment key={column.key}>
                          {cell(
                            row.cells[column.key],
                            "text-[13px] text-muted-foreground",
                          )}
                        </Fragment>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              </RowMenu>
            );
          })}
        </View>
      )}
      {selecting && shown.length ? (
        <>
          {/* Room under the last row for the bar. */}
          <View style={{ height: 60 + bottom }} />
          {focused ? (
            <Portal name={bar}>
              <View
                className="absolute inset-x-0 bottom-0 flex-row items-center justify-around border-t border-border bg-card px-2 pt-1.5"
                style={{ paddingBottom: bottom + 6 }}
              >
                {shown.map((item) => (
                  <BarAction key={item.title} item={item} off={!chosen.size} />
                ))}
              </View>
            </Portal>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
