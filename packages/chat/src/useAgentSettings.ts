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

/** Request generations belong to this exact workspace/actor, never a previous connection. */
function useSettingsResource<T>(
  path: string,
  kernel: string,
  revision: string,
) {
  const key = `${kernel}\n${path}`;
  const [generation, setGeneration] = useState(0);
  const epoch = useRef(0);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    loading: boolean;
    error: string;
  }>({ key, loading: true, error: "" });
  useEffect(() => {
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
    refresh: () => {
      epoch.current++;
      setGeneration((value) => value + 1);
    },
    update: (update: (data: T) => T) => {
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
) {
  return useSettingsResource<{ models: AgentModelOption[] }>(
    `/sessions/catalog?harness=${encodeURIComponent(harness)}`,
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
      return confirmed;
    },
  };
}

// Each kernel's catalog of a harness, read once: the names its models go by change rarely.
const catalogs = new Map<string, Promise<AgentModelOption[]>>();

/**
 * The names models go by, as each harness's catalog gives them, for lists that show which
 * model an agent works with: a model's label, else the model as it is written.
 */
export function useModelLabels(kernel = kernelUrl()) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const harness of Object.keys(harnessLabels)) {
      const key = `${kernel}\n${harness}`;
      let catalog = catalogs.get(key);
      if (!catalog) {
        catalog = request<{ models: AgentModelOption[] }>(
          kernel,
          `/sessions/catalog?harness=${encodeURIComponent(harness)}`,
        ).then(({ models }) => models);
        catalogs.set(key, catalog);
        // An unread catalog is asked for again next time.
        catalog.catch(() => catalogs.delete(key));
      }
      catalog.then(
        (models) =>
          live &&
          setLabels((all) => ({
            ...all,
            ...Object.fromEntries(
              models.map((model) => [
                `${harness}\n${model.value}`,
                model.label,
              ]),
            ),
          })),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [kernel]);
  return useCallback(
    (harness: string, model: string) => labels[`${harness}\n${model}`] ?? model,
    [labels],
  );
}
