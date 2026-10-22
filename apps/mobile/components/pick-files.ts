import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Alert } from "react-native";
import { errorMessage } from "@zerolux/chat";
import type { MenuItem, PickedFile } from "@zerolux/ui";

/** A picked file's bytes, typed as the picker says, with its name. */
async function read(uri: string, name: string, type?: string | null) {
  const blob = await (await fetch(uri)).blob();
  return {
    file: type && blob.type !== type ? new Blob([blob], { type }) : blob,
    name,
  } satisfies PickedFile;
}

/**
 * Files from where the phone keeps them: its photos, its camera or its files, as they are;
 * none when the person cancels. The system's refusal of the camera says where to allow it.
 */
export async function pickFiles(
  from: "library" | "camera" | "files",
  multiple: boolean,
): Promise<PickedFile[]> {
  if (from === "files") {
    const picked = await DocumentPicker.getDocumentAsync({
      multiple,
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return [];
    return Promise.all(
      picked.assets.map((a) => read(a.uri, a.name, a.mimeType)),
    );
  }
  if (
    from === "camera" &&
    !(await ImagePicker.requestCameraPermissionsAsync()).granted
  )
    throw new Error(
      "Camera access for ZeroLux is off in the phone's Settings.",
    );
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images", "videos"],
    quality: 1,
    allowsMultipleSelection: multiple,
  };
  const picked =
    from === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (picked.canceled) return [];
  return Promise.all(
    picked.assets.map((a) =>
      read(a.uri, a.fileName ?? a.uri.split("/").pop() ?? "photo", a.mimeType),
    ),
  );
}

/** Where files are picked from, as a menu's rows: each gives what was picked to `onFiles`. */
export const fileSources = (
  multiple: boolean,
  onFiles: (files: PickedFile[]) => void,
): MenuItem[] =>
  (
    [
      ["library", "Photo library", "image"],
      ["camera", "Take photo", "camera"],
      ["files", "Files", "folder"],
    ] as const
  ).map(([from, title, icon]) => ({
    title,
    icon,
    onPress: () =>
      void pickFiles(from, multiple).then(
        (files) => files.length && onFiles(files),
        (e: unknown) => Alert.alert(errorMessage(e)),
      ),
  }));
