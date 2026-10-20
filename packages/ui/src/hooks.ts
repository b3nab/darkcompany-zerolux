import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  errorMessage,
  listenUi,
  request,
  requestFile,
  runAction,
  withContext,
} from "@zerolux/chat";
import type {
  ExtensionAction,
  JsonSchema,
  UiContext,
  UiPiece,
} from "@zerolux/chat";

/** Where a view shows, as the app that shows it tells. */
export interface Here {
  piece: UiPiece;
  context: UiContext;
  kernel: string;
  /** Keeps a file the view gives, as the app keeps files: saved or shared. */
  save: (file: Blob, name: string) => Promise<void>;
}

/** Where a view shows, with its extension's actions once read: their inputs say what to give. */
export interface Shown extends Here {
  actions?: ExtensionAction[];
}

export const HereContext = createContext<Shown | undefined>(undefined);

function useHere() {
  const here = useContext(HereContext);
  if (!here) throw new Error("This view shows only inside ZeroLux");
  return here;
}

/** An event by its full name: one of the extension's own may be named without it. */
export const eventName = (extension: string, event: string) =>
  event.includes("/") ? event : `${extension}/${event}`;

const actionPath = (here: Here, action: string) =>
  `/ext/${encodeURIComponent(here.piece.extension)}/${encodeURIComponent(action)}`;

/** One of the extension's actions, with the place the view shows in where its input asks. */
export const callAction = (
  here: Here,
  action: string,
  input: Record<string, unknown>,
  schema?: JsonSchema,
) =>
  runAction(
    here.piece.extension,
    action,
    withContext(input, schema, here.context),
    here.kernel,
  );

const inAddress = (
  here: Here,
  input: Record<string, unknown>,
  schema?: JsonSchema,
) =>
  encodeURIComponent(JSON.stringify(withContext(input, schema, here.context)));

/** An action run on a file: the file goes as it is, its input and name in the address. */
export const sendFile = (
  here: Here,
  action: string,
  file: Blob,
  name: string,
  input: Record<string, unknown>,
  schema?: JsonSchema,
) =>
  request<{ result: unknown }>(
    here.kernel,
    `${actionPath(here, action)}/file?input=${inAddress(here, input, schema)}&name=${encodeURIComponent(name)}`,
    file,
  ).then(({ result }) => result);

/** The file an action gives, with the name it gives it. */
export const receiveFile = (
  here: Here,
  action: string,
  input: Record<string, unknown>,
  schema?: JsonSchema,
) =>
  requestFile(
    here.kernel,
    `${actionPath(here, action)}?input=${inAddress(here, input, schema)}`,
  );

/** An action's input schema, so the place is given only where it is asked. */
const schemaOf = (here: Shown, name: string) =>
  here.actions?.find(
    (a) => a.extension === here.piece.extension && a.name === name,
  )?.input;

/** Running something: busy until it ends, and what went wrong, in a sentence. */
function useRunning<A extends unknown[], R>(work: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      setError("");
      try {
        return await work(...args);
      } catch (e) {
        setError(errorMessage(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [work],
  );
  return { busy, error, run };
}

/** Where the view shows: its space, and the chat, session or message it shows for. */
export function useSpace() {
  const { piece, context } = useHere();
  return { space: piece.space, context };
}

/**
 * One of the extension's actions, to run from the view: `run` gives its result, or throws
 * what went wrong, kept in `error` too.
 */
export function useAction(name: string) {
  const here = useHere();
  const work = useCallback(
    (input: Record<string, unknown> = {}) =>
      callAction(here, name, input, schemaOf(here, name)),
    [here, name],
  );
  return useRunning(work);
}

/**
 * What an action gives, read when the view shows and when its input changes, and again
 * when notices may have been missed; `reload` reads it again now.
 */
export function useActionResult<T = unknown>(
  name: string,
  input: Record<string, unknown> = {},
) {
  const here = useHere();
  const [state, setState] = useState<{
    data?: T;
    error: string;
    loading: boolean;
  }>({ error: "", loading: true });
  // The input as text, so a new object with the same values reads nothing again.
  const asked = JSON.stringify(input);
  // Read once the actions are known, so the place goes with the first read.
  const known = here.actions !== undefined;
  // Only the latest read shows: an earlier one that ends later is dropped.
  const reads = useRef(0);
  const reload = useCallback(async () => {
    if (!known) return;
    const at = ++reads.current;
    setState((was) => ({ ...was, loading: true }));
    try {
      const data = (await callAction(
        here,
        name,
        JSON.parse(asked) as Record<string, unknown>,
        schemaOf(here, name),
      )) as T;
      if (at === reads.current) setState({ data, error: "", loading: false });
    } catch (e) {
      if (at === reads.current)
        setState((was) => ({ ...was, error: errorMessage(e), loading: false }));
    }
  }, [here, name, asked, known]);
  useEffect(() => void reload(), [reload]);
  useEffect(
    () =>
      listenUi((notice) => {
        if (notice.type === "resync") void reload();
      }),
    [reload],
  );
  return { ...state, reload };
}

/** Hears an event an extension publishes: by its full name, or its own by its short one. */
export function useEvent(event: string, handler: () => void) {
  const here = useHere();
  const name = eventName(here.piece.extension, event);
  const handle = useRef(handler);
  handle.current = handler;
  useEffect(
    () =>
      listenUi((notice) => {
        if (notice.type === "extension.event" && notice.event === name)
          handle.current();
      }),
    [name],
  );
}

/** Sends a file to an action, which gets it as `file` beside its input: its result. */
export function useUpload(action: string) {
  const here = useHere();
  const work = useCallback(
    (file: Blob, name: string, input: Record<string, unknown> = {}) =>
      sendFile(here, action, file, name, input, schemaOf(here, action)),
    [here, action],
  );
  const { run, ...rest } = useRunning(work);
  return { upload: run, ...rest };
}

/** The file an action gives, kept as the app keeps files. */
export function useDownload(action: string) {
  const here = useHere();
  const work = useCallback(
    async (input: Record<string, unknown> = {}) => {
      const { blob, name } = await receiveFile(
        here,
        action,
        input,
        schemaOf(here, action),
      );
      await here.save(blob, name ?? action);
    },
    [here, action],
  );
  const { run, ...rest } = useRunning(work);
  return { download: run, ...rest };
}
