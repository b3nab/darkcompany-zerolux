import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  harnessLabels,
  kernelUrl,
  request,
  type Actor,
} from "./client";
import type {
  AgentModelOption,
  AgentSettings,
  AgentSettingsView,
  SessionSettingsView,
} from "./workspace";
import { isLooking, whenLooking } from "./reading";
import { rereadShown, sharedRead, useSharedRead } from "./shared-read";

/** Request generations belong to this exact workspace/actor, never a previous connection. */
function useSettingsResource<T>(
  path: string,
  kernel: string,
  revision: string,
) {
  const key = `${kernel}\n${path}`;
  const [generation, setGeneration] = useState(0);
  const epoch = useRef(0);
  const readingKey = useRef(key);
  const refresh = useCallback(() => {
    epoch.current++;
    setGeneration((value) => value + 1);
  }, []);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    loading: boolean;
    error: string;
  }>({ key, loading: true, error: "" });
  useEffect(() => whenLooking(() => isLooking() && refresh()), [refresh]);
  useEffect(() => {
    readingKey.current = key;
    const controller = new AbortController();
    const ticket = ++epoch.current;
    let current = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
      error: "",
    }));
    void request<T>(kernel, path, undefined, controller.signal).then(
      (data) => {
        if (current && ticket === epoch.current)
          setState({ key, data, loading: false, error: "" });
      },
      (error: unknown) => {
        if (current && ticket === epoch.current)
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            loading: false,
            error: errorMessage(error),
          }));
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [key, kernel, path, generation, revision]);
  return {
    data: state.key === key ? state.data : undefined,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : "",
    refresh,
    update: (update: (data: T) => T) => {
      if (readingKey.current !== key) return;
      epoch.current++;
      setState((previous) =>
        previous.key === key && previous.data
          ? {
              ...previous,
              data: update(previous.data),
              loading: false,
              error: "",
            }
          : previous,
      );
    },
  };
}

export function useAgentSettings(
  actor: Actor,
  revision = "",
  kernel = kernelUrl(),
) {
  const resource = useSettingsResource<AgentSettingsView>(
    `/actors/${encodeURIComponent(actor.id)}/settings`,
    kernel,
    JSON.stringify([
      revision,
      actor.model,
      actor.effort,
      actor.permission_mode,
      actor.approval_policy,
      actor.sandbox,
    ]),
  );
  return {
    ...resource,
    accept: (actor: Actor) => resource.update((data) => ({ ...data, actor })),
  };
}

/** The models and efforts a new session of this harness can start with. */
export function useSessionCatalog(
  harness: NonNullable<Actor["harness"]>,
  kernel = kernelUrl(),
  host?: string,
  workspace?: string,
) {
  const [folder, setFolder] = useState(workspace);
  useEffect(() => {
    const timer = setTimeout(() => setFolder(workspace?.trim()), 300);
    return () => clearTimeout(timer);
  }, [workspace]);
  return useSettingsResource<{ models: AgentModelOption[] }>(
    `/sessions/catalog?harness=${encodeURIComponent(harness)}${host ? `&host=${encodeURIComponent(host)}` : ""}${folder ? `&workspace=${encodeURIComponent(folder)}` : ""}`,
    kernel,
    "",
  );
}

/**
 * A session's own model, effort and permissions, read from its harness; `apply` changes them
 * through it and shows what the harness confirmed.
 */
export function useSessionSettings(
  sessionId: string,
  revision = "",
  kernel = kernelUrl(),
) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/settings`;
  const resource = useSettingsResource<SessionSettingsView>(
    path,
    kernel,
    revision,
  );
  return {
    ...resource,
    async apply(change: AgentSettings) {
      const confirmed = await request<SessionSettingsView>(
        kernel,
        path,
        change,
        undefined,
        "PATCH",
      );
      resource.update(() => confirmed);
      rereadShown(readModelLabels, kernel);
      return confirmed;
    },
  };
}

/** Read each native catalog anew; a harness that cannot answer leaves its IDs as they are. */
async function readModelLabels(kernel: string) {
  const catalogs = await Promise.allSettled(
    Object.keys(harnessLabels).map(async (harness) => {
      const { models } = await request<{ models: AgentModelOption[] }>(
        kernel,
        `/sessions/catalog?harness=${encodeURIComponent(harness)}`,
      );
      return models.flatMap((model) =>
        [model.value, model.resolved_model]
          .filter((value): value is string => value !== undefined)
          .map((value) => [`${harness}\n${value}`, model.label]),
      );
    }),
  );
  return Object.fromEntries(
    catalogs.flatMap((catalog) =>
      catalog.status === "fulfilled" ? catalog.value : [],
    ),
  ) as Record<string, string>;
}

/**
 * The names models go by, as each harness's catalog gives them, for lists that show which
 * model an agent works with: a model's label, else the model as it is written.
 */
export function useModelLabels(kernel = kernelUrl()) {
  const { read } = useSharedRead(readModelLabels, kernel, true);
  useEffect(() => {
    const refresh = () => void sharedRead(readModelLabels, kernel, true);
    refresh();
    return whenLooking(() => isLooking() && refresh());
  }, [kernel]);
  const labels = read?.items;
  return useCallback(
    (harness: string, model: string) =>
      labels?.[`${harness}\n${model}`] ?? model,
    [labels],
  );
}
