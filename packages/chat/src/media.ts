import { useEffect, useState } from "react";
import { kernelUrl, requestFile } from "./client";
import { requestCredential } from "./credentials";

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * The file on a session's computer that a link or an image's source in its text names: an
 * absolute path, one in the home (`~/`), a `file://` address, one beside the session's folder
 * (`./`, `../`) or a Windows one (`C:\`). Nothing for the web, mail or a page's own anchor.
 */
export function localPath(href: string): string | undefined {
  const value = href.trim().replace(/^<(.*)>$/, "$1");
  if (/^file:\/\//i.test(value)) {
    try {
      const path = decodeURIComponent(new URL(value).pathname);
      return path.replace(/^\/([a-z]:\/)/i, "$1") || undefined;
    } catch {
      return undefined;
    }
  }
  if (!/^(?:\/(?!\/)|~\/|\.\.?\/|[a-z]:[\\/])/i.test(value)) return undefined;
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** A file to show as a picture, by its name's extension. */
export const localImage = (path: string) => IMAGE.test(path.split(/[?#]/)[0]!);

const mediaPath = (sessionId: string, path: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/media?path=${encodeURIComponent(path)}`;

/**
 * Where the kernel gives an image a session's text names, read on the session's computer, and
 * the headers that let a native client read it: an image source as React Native takes it.
 */
export function sessionMedia(
  sessionId: string,
  path: string,
  kernel = kernelUrl(),
) {
  const token = requestCredential(kernel)?.token;
  return {
    uri: `${kernel.replace(/\/+$/, "")}/api${mediaPath(sessionId, path)}`,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  };
}

/**
 * An image a session's text names, read from the kernel as the person, as an address a page
 * shows (a blob URL, let go when it is no longer shown), or that it could not be read.
 */
export function useSessionMedia(
  sessionId: string,
  path: string | undefined,
  kernel = kernelUrl(),
) {
  const [shown, setShown] = useState<{ url?: string; failed: boolean }>({
    failed: false,
  });
  useEffect(() => {
    setShown({ failed: false });
    if (!path) return;
    const abort = new AbortController();
    let url: string | undefined;
    requestFile(kernel, mediaPath(sessionId, path), abort.signal).then(
      ({ blob }) => {
        url = URL.createObjectURL(blob);
        setShown({ url, failed: false });
      },
      () => {
        if (!abort.signal.aborted) setShown({ failed: true });
      },
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionId, path, kernel]);
  return shown;
}
