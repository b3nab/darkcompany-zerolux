import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { InputImage } from "@zerolux/chat";

/** A photo ready to go with an input: JPEG, as large as a model reads well, with its preview. */
export interface Photo extends InputImage {
  uri: string;
  /** Its bytes, as the kernel counts them. */
  size: number;
}

/** The longest side kept: enough to read a screenshot, well within what one input carries. */
const SIDE = 2048;

/**
 * The photo as JPEG, decoded no larger than it needs to be, so a camera's HEIC photos and
 * screenshots alike arrive in a format every harness takes.
 */
async function prepare(uri: string): Promise<Photo> {
  const image = await ImageManipulator.manipulate(uri, {
    maxWidth: SIDE,
    maxHeight: SIDE,
  }).renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.8,
    base64: true,
  });
  const data = saved.base64 ?? "";
  return {
    media_type: "image/jpeg",
    data,
    uri: saved.uri,
    size: Math.floor((data.length * 3) / 4),
  };
}

/**
 * Photos from the library, up to `room` of them, or one from the camera; none when the owner
 * cancels. The system's refusal of the camera says where to allow it.
 */
export async function pickPhotos(
  from: "library" | "camera",
  room: number,
): Promise<Photo[]> {
  if (from === "camera") {
    const allowed = await ImagePicker.requestCameraPermissionsAsync();
    if (!allowed.granted)
      throw new Error(
        "Camera access for ZeroLux is off in the phone's Settings.",
      );
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    quality: 1,
  };
  const result =
    from === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync({
          ...options,
          allowsMultipleSelection: true,
          selectionLimit: room,
        });
  if (result.canceled) return [];
  return Promise.all(result.assets.map((asset) => prepare(asset.uri)));
}
