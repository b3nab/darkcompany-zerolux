/**
 * Storage's provider for a Google Drive folder, over Drive's REST API: each Storage key is a
 * file of that name in the folder. What each operation does, with any `fetch`.
 */
import { join } from "node:path";

export interface Drive {
  folder: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const TOKEN = "https://oauth2.googleapis.com/token";
export const API = "https://www.googleapis.com/drive/v3";
export const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const checkKey = (key: string) => {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(key)) throw new Error("Invalid key");
  return key;
};

async function ok(response: Response, what: string) {
  if (!response.ok)
    throw new Error(`Google Drive did not ${what} (${response.status})`);
  return response;
}

export function operations(
  drive: () => Drive,
  folder: () => string,
  call: Fetch = fetch,
) {
  let token: { value: string; until: number; for: string } | undefined;
  const access = async () => {
    const settings = drive();
    if (!settings.folder || !settings.refreshToken)
      throw new Error(
        "Choose the folder and sign in in Google Drive's settings",
      );
    const owner = `${settings.clientId}:${settings.refreshToken}`;
    if (token && token.for === owner && token.until > Date.now())
      return token.value;
    const answer = (await (
      await ok(
        await call(TOKEN, {
          method: "POST",
          body: new URLSearchParams({
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            refresh_token: settings.refreshToken,
            grant_type: "refresh_token",
          }),
        }),
        "sign in",
      )
    ).json()) as { access_token: string; expires_in?: number };
    token = {
      value: answer.access_token,
      until: Date.now() + (Number(answer.expires_in ?? 3600) - 60) * 1000,
      for: owner,
    };
    return token.value;
  };
  const headers = async () => ({ authorization: `Bearer ${await access()}` });
  /** The Drive file a key is kept as, if there is one. */
  const find = async (key: string) => {
    const query = `name = '${checkKey(key)}' and '${drive().folder}' in parents and trashed = false`;
    const found = (await (
      await ok(
        await call(
          `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)`,
          {
            headers: await headers(),
          },
        ),
        "find the file",
      )
    ).json()) as { files?: { id: string }[] };
    return found.files?.[0]?.id;
  };
  return {
    put: async (input: {
      key: string;
      path: string;
      content_type?: string;
    }) => {
      const form = new FormData();
      form.append(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              name: checkKey(input.key),
              parents: [drive().folder],
            }),
          ],
          {
            type: "application/json",
          },
        ),
      );
      form.append(
        "file",
        new Blob([await Bun.file(input.path).arrayBuffer()], {
          type: input.content_type || "application/octet-stream",
        }),
      );
      await ok(
        await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
          method: "POST",
          headers: await headers(),
          body: form,
        }),
        "keep the file",
      );
      return {};
    },
    /** A copy in the extension's folder, which the kernel removes once sent. */
    get: async (input: { key: string }) => {
      const id = await find(input.key);
      if (!id) throw new Error("The file's bytes are not in the Drive folder");
      const response = await ok(
        await call(`${API}/files/${id}?alt=media`, {
          headers: await headers(),
        }),
        "give the file",
      );
      const path = join(folder(), `.get-${crypto.randomUUID()}`);
      await Bun.write(path, response);
      return { path, temporary: true };
    },
    delete: async (input: { key: string }) => {
      const id = await find(input.key);
      if (id)
        await ok(
          await call(`${API}/files/${id}`, {
            method: "DELETE",
            headers: await headers(),
          }),
          "delete the file",
        );
      return {};
    },
  };
}
