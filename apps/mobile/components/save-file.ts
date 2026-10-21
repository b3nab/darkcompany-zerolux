import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

/** A file's bytes as a `data:` address. */
export const dataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file can't be read"));
    reader.readAsDataURL(file);
  });

/** A file written in the phone's cache and offered to open, save or share. */
export async function saveFile(file: Blob, name: string) {
  const url = await dataUrl(file);
  const kept = new File(Paths.cache, name.replace(/[/\\]/g, "_"));
  kept.create({ overwrite: true });
  kept.write(url.slice(url.indexOf(",") + 1), { encoding: "base64" });
  await Sharing.shareAsync(kept.uri, {
    mimeType: file.type || undefined,
    dialogTitle: name,
  });
}
