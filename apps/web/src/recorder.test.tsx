import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useRecorder } from "./recorder";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const reset of restore.splice(0).reverse()) reset();
});

function replace(name: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  restore.push(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function fixture() {
  const denied = new DOMException("", "NotAllowedError");
  const state = {
    blocked: false,
    broken: false,
    requests: 0,
    tracks: 0,
    contexts: 0,
  };
  replace("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        state.requests++;
        if (state.blocked) throw denied;
        state.tracks++;
        return {
          getTracks: () => [
            {
              stop: () => {
                state.tracks--;
              },
            },
          ],
        };
      },
    },
  });
  replace(
    "AudioContext",
    class {
      constructor() {
        state.contexts++;
      }
      createAnalyser() {
        return {};
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      async close() {
        state.contexts--;
      }
    },
  );
  replace(
    "MediaRecorder",
    class {
      state = "inactive";
      mimeType = "audio/webm";
      onstop?: () => void;
      constructor(readonly stream: unknown) {}
      start() {
        if (state.broken) throw new DOMException("", "NotSupportedError");
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    },
  );
  let mic!: ReturnType<typeof useRecorder>;
  function Composer() {
    mic = useRecorder();
    return null;
  }
  renderToStaticMarkup(<Composer />);
  return { state, mic, denied };
}

test("denied capture never opens a track or starts recording; a later explicit request can succeed", async () => {
  const { state, mic, denied } = fixture();
  expect(state.requests).toBe(0);
  state.blocked = true;
  const failure = await mic.start().catch((error: Error) => error);
  expect((failure as Error).cause).toBe(denied);
  expect([state.requests, state.tracks, state.contexts]).toEqual([1, 0, 0]);
  expect(await mic.stop()).toBeUndefined();
  state.blocked = false;
  await mic.start();
  expect(await mic.stop()).toBeInstanceOf(Blob);
  expect([state.requests, state.tracks, state.contexts]).toEqual([2, 0, 0]);
});

test("a recorder that cannot start releases the acquired microphone and audio context", async () => {
  const { state, mic } = fixture();
  state.broken = true;
  await expect(mic.start()).rejects.toThrow();
  expect([state.tracks, state.contexts]).toEqual([0, 0]);
  expect(await mic.stop()).toBeUndefined();
});
