import { createContext, use, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { ImageIcon, XIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { localImage, localPath, sessionMedia } from "@zerolux/chat";
import { Text } from "@/components/ui/text";

/** The session whose text names files on its computer: its ID, its folder there, its kernel. */
export const SessionFiles = createContext<
  { sessionId: string; folder: string; kernel: string } | undefined
>(undefined);

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * What a session's text can do with the files it names: show an image from the kernel, and
 * open a file, an image whole, another file in the session's file viewer when it is in the
 * session's folder, else its path to copy. None outside a session.
 */
export function useLocalFiles() {
  const files = use(SessionFiles);
  const router = useRouter();
  const [viewing, setViewing] = useState<{ paths: string[]; at: number }>();
  if (!files) return undefined;
  const inFolder = (path: string) => {
    const folder = files.folder.replace(/\/+$/, "");
    if (path.startsWith(`${folder}/`)) return path.slice(folder.length + 1);
    if (path.startsWith("./")) return path.slice(2);
    return /^(?:\/|~|\.\.\/|[a-z]:[\\/])/i.test(path) ? undefined : path;
  };
  return {
    source: (path: string) => sessionMedia(files.sessionId, path, files.kernel),
    /** Opens a file the text names; an image among `paths`, to go from one to the next. */
    open: (path: string, paths: string[] = [path]) => {
      if (localImage(path))
        return setViewing({ paths, at: Math.max(0, paths.indexOf(path)) });
      const inside = inFolder(path);
      if (inside)
        return router.push({
          pathname: "/file/[id]",
          params: { id: files.sessionId, path: inside },
        });
      Alert.alert(baseName(path), path, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Copy path",
          onPress: () => void Clipboard.setStringAsync(path),
        },
      ]);
    },
    viewer: viewing ? (
      <ImageViewer
        sessionId={files.sessionId}
        kernel={files.kernel}
        paths={viewing.paths}
        at={viewing.at}
        close={() => setViewing(undefined)}
      />
    ) : null,
  };
}

/**
 * The images a piece of a session's text names on its computer, each small with its name; a
 * tap shows it whole. One the kernel cannot give stays its name and path, never a broken image.
 */
export function LocalImages({
  paths,
  open,
}: {
  paths: string[];
  open: (path: string, paths: string[]) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 py-1"
    >
      {paths.map((path) => (
        <Thumbnail key={path} path={path} open={() => open(path, paths)} />
      ))}
    </ScrollView>
  );
}

function Thumbnail({ path, open }: { path: string; open: () => void }) {
  const files = use(SessionFiles);
  const [failed, setFailed] = useState(false);
  const faint = String(useCSSVariable("--color-faint"));
  if (!files) return null;
  return (
    <Pressable
      onPress={open}
      accessibilityRole="imagebutton"
      accessibilityLabel={baseName(path)}
      className="w-28 gap-1 active:opacity-70"
    >
      <View className="h-20 w-28 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {failed ? (
          <ImageIcon color={faint} size={20} strokeWidth={1.5} />
        ) : (
          <Image
            source={sessionMedia(files.sessionId, path, files.kernel)}
            resizeMode="cover"
            onError={() => setFailed(true)}
            className="size-full"
          />
        )}
      </View>
      <Text numberOfLines={1} className="font-mono text-[11px] text-faint">
        {baseName(path)}
      </Text>
    </Pressable>
  );
}

/**
 * Images whole on a dark screen, one after another by a swipe, each zoomed with two fingers;
 * its path below, to copy.
 */
function ImageViewer({
  sessionId,
  kernel,
  paths,
  at,
  close,
}: {
  sessionId: string;
  kernel: string;
  paths: string[];
  at: number;
  close: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(at);
  const path = paths[index] ?? paths[0]!;
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View className="flex-1 bg-black">
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: at * width, y: 0 }}
          onMomentumScrollEnd={(event) =>
            setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
          }
        >
          {paths.map((each) => (
            <Page
              key={each}
              source={sessionMedia(sessionId, each, kernel)}
              name={baseName(each)}
              width={width}
              height={height}
            />
          ))}
        </ScrollView>
        <View
          className="absolute inset-x-0 top-0 flex-row items-center justify-between px-4"
          style={{ paddingTop: insets.top + 8 }}
        >
          {paths.length > 1 ? (
            <Text className="rounded-full bg-black/60 px-2.5 py-1 font-mono text-xs text-white">
              {`${index + 1} / ${paths.length}`}
            </Text>
          ) : (
            <View />
          )}
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            className="size-9 items-center justify-center rounded-full bg-black/60"
          >
            <XIcon color="#fff" size={18} strokeWidth={2} />
          </Pressable>
        </View>
        <Pressable
          onLongPress={() => {
            void Haptics.selectionAsync();
            void Clipboard.setStringAsync(path);
          }}
          accessibilityHint="Long press to copy the path"
          className="absolute inset-x-0 bottom-0 bg-black/60 px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <Text
            numberOfLines={2}
            ellipsizeMode="head"
            className="font-mono text-xs text-white"
          >
            {path}
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** One image whole, zoomed with two fingers; one the kernel cannot give is its icon. */
function Page({
  source,
  name,
  width,
  height,
}: {
  source: ReturnType<typeof sessionMedia>;
  name: string;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <View style={{ width, height }} className="items-center justify-center">
        <ImageIcon color="#ffffff80" size={32} strokeWidth={1.5} />
      </View>
    );
  return (
    <ScrollView
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      style={{ width, height }}
    >
      <Image
        source={source}
        resizeMode="contain"
        accessibilityLabel={name}
        onError={() => setFailed(true)}
        style={{ width, height }}
      />
    </ScrollView>
  );
}

/** The files on its computer that a piece of a session's text links or shows, as written. */
export function namedFiles(hrefs: string[]) {
  const all = hrefs.flatMap((href) => localPath(href) ?? []);
  return [...new Set(all)];
}
