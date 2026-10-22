import * as Haptics from "expo-haptics";
import { ChevronRightIcon, HouseIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { errorMessage, readFolders } from "@zerolux/chat";
import type { FolderListing } from "@zerolux/chat";
import type { FolderInputProps } from "@zerolux/ui";
import { PageSheet } from "@/components/page-sheet";
import { Menu } from "@/components/action-menu";
import { SearchField } from "@/components/search-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Icon } from "@/components/ui-icon";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";

/** A folder's own name, the last of its path. */
const named = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The folders on the way to `path`: from home when it is inside, else from the disk's top. */
function way(path: string, home: string | null) {
  const stops = [
    ...new Set([
      ...[...path.matchAll(/[\\/]/g)].map(({ index }, n) =>
        path.slice(0, n ? index : index + 1),
      ),
      path,
    ]),
  ];
  return stops.slice(Math.max(home ? stops.indexOf(home) : 0, 0));
}

/**
 * A folder on the kernel's computer, never typed: Choose opens a sheet that walks its folders,
 * from home down.
 */
export function FolderInput({
  value,
  onChange,
  label,
  disabled,
}: FolderInputProps) {
  const [choosing, setChoosing] = useState(false);
  return (
    <View className="gap-1.5">
      {label ? <Text className="text-sm font-medium">{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? "Folder"}
        accessibilityValue={{ text: value ?? "None" }}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          void Haptics.selectionAsync();
          setChoosing(true);
        }}
        className={cn(
          "min-h-12 flex-row items-center gap-3 rounded-md border border-border bg-card px-3.5 py-2.5 active:bg-accent",
          disabled && "opacity-50",
        )}
      >
        <Icon name="folder-closed" />
        <View className="min-w-0 flex-1 gap-0.5">
          {value ? (
            <>
              <Text numberOfLines={1} className="text-[15px] font-medium">
                {named(value)}
              </Text>
              <Text
                numberOfLines={1}
                className="text-[13px] text-muted-foreground"
              >
                {value}
              </Text>
            </>
          ) : (
            <Text className="text-[15px] text-faint">None</Text>
          )}
        </View>
        <Text className="text-[15px] font-medium text-human-foreground">
          Choose
        </Text>
      </Pressable>
      {choosing ? (
        <FolderSheet
          from={value}
          onClose={() => setChoosing(false)}
          onChoose={(path) => {
            setChoosing(false);
            onChange(path);
          }}
        />
      ) : null}
    </View>
  );
}

/** The kernel computer's folders, one at a time: the way back up on top, Use this folder below. */
function FolderSheet({
  from,
  onClose,
  onChoose,
}: {
  from: string | null;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const { url } = useSession();
  const { bottom } = useSafeAreaInsets();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const faint = String(useCSSVariable("--color-faint"));
  const [path, setPath] = useState(from ?? undefined);
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  // Where its folders cannot be walked (only its own person may), the path is written.
  const [written, setWritten] = useState(from ?? "");
  useEffect(() => {
    let shown = true;
    setError("");
    setQuery("");
    readFolders(path, url).then(
      (read) => shown && setListing(read),
      (e: unknown) => {
        if (!shown) return;
        setError(errorMessage(e));
        // The folder that could not be read is the one to write, or to correct.
        if (path) setWritten(path);
      },
    );
    return () => {
      shown = false;
    };
  }, [path, url]);
  const here =
    listing && (!path || listing.path === path) ? listing : undefined;
  const chosen = error ? written.trim() : here?.path;
  const folders = (here?.folders ?? []).filter(
    (folder) =>
      (hidden || !folder.hidden) &&
      folder.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <PageSheet open={true} onClose={onClose}>
      <View className="flex-row items-center justify-between border-b border-border py-1.5 pr-2 pl-5">
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
          <Text className="text-base font-medium text-human-foreground">
            Cancel
          </Text>
        </Pressable>
        <Text className="text-[17px] font-semibold">Choose a folder</Text>
        <Menu
          label="More"
          items={[
            {
              title: "Show hidden folders",
              checked: hidden,
              onPress: () => setHidden(!hidden),
            },
            ...(listing?.home
              ? [
                  { divider: true as const },
                  {
                    title: "Home",
                    icon: "house",
                    onPress: () => setPath(listing.home ?? undefined),
                  },
                ]
              : []),
          ]}
        />
      </View>
      <ScrollView
        contentContainerClassName="gap-3 px-4 pt-3 pb-6"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {here ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="items-center gap-1"
          >
            {way(here.path, here.home).map((stop, i, all) => {
              const last = i === all.length - 1;
              return (
                <View key={stop} className="flex-row items-center gap-1">
                  {i ? (
                    <ChevronRightIcon
                      color={faint}
                      size={14}
                      strokeWidth={1.5}
                    />
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={last}
                    onPress={() => setPath(stop)}
                    hitSlop={6}
                    className="flex-row items-center gap-1 active:opacity-60"
                  >
                    {stop === here.home ? (
                      <HouseIcon color={muted} size={14} strokeWidth={1.5} />
                    ) : null}
                    <Text
                      className={cn(
                        "text-[13px]",
                        last
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {named(stop)}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        ) : null}
        {here?.folders.length ? (
          <SearchField
            value={query}
            onChange={setQuery}
            label={`Search in ${named(here.path)}`}
          />
        ) : null}
        {error ? (
          <View className="gap-2">
            <Text className="text-sm text-destructive">{error}</Text>
            <Input
              value={written}
              onChangeText={setWritten}
              placeholder="Folder's full path"
              accessibilityLabel="Folder's full path"
              autoCapitalize="none"
              autoCorrect={false}
              className="font-mono text-[13px]"
            />
            {path ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setPath(undefined)}
                className="self-start"
              >
                <Text className="text-[15px] font-medium text-human-foreground">
                  Home
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : !here ? (
          <ActivityIndicator size="small" color={muted} className="mt-4" />
        ) : folders.length ? (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {folders.map((folder, i) => (
              <Pressable
                key={folder.path}
                accessibilityRole="button"
                onPress={() => setPath(folder.path)}
                className={cn(
                  "min-h-12 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-accent",
                  i > 0 && "border-t border-border",
                )}
              >
                <Icon name="folder-closed" />
                <Text
                  numberOfLines={1}
                  className={cn(
                    "flex-1 text-[15px]",
                    folder.hidden && "text-muted-foreground",
                  )}
                >
                  {folder.name}
                </Text>
                <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
              </Pressable>
            ))}
          </View>
        ) : (
          <Text className="py-6 text-center text-sm text-faint">
            {query.trim() ? "No folder matches." : "No folders."}
          </Text>
        )}
        {here?.truncated ? (
          <Text className="text-center text-xs text-faint">
            {`The first ${here.folders.length} folders by name.`}
          </Text>
        ) : null}
      </ScrollView>
      <View
        className="gap-1.5 border-t border-border px-4 pt-3"
        style={{ paddingBottom: bottom + 12 }}
      >
        <Button disabled={!chosen} onPress={() => chosen && onChoose(chosen)}>
          <Text>Use this folder</Text>
        </Button>
        {chosen ? (
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            className="text-center text-[12.5px] text-muted-foreground"
          >
            {chosen}
          </Text>
        ) : null}
      </View>
    </PageSheet>
  );
}
