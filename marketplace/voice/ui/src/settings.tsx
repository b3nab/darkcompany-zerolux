import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Icon,
  Input,
  Section,
  Select,
  Spinner,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  useAction,
  useActionResult,
  useEvent,
} from "@zerolux/ui";
import type { MenuEntry, TableRow } from "@zerolux/ui";

interface Model {
  id: string;
  engine: string;
  title: string;
  variant: string;
  languages: string;
  size: number;
  memory: number;
  licence: string;
  suggested: string;
  vocabulary: boolean;
  state: "absent" | "downloading" | "ready" | "failed";
  done?: number;
  total?: number;
  speed?: number;
  error?: string | null;
}

interface Settings {
  config: {
    engine: string;
    model: string;
    language: string;
    vad: boolean;
    keep: number;
    vocabulary: string[];
  };
  status: {
    state: "loading" | "loaded" | "unloaded" | "failed";
    model: string | null;
    backend: string | null;
    memory: number | null;
    error: string | null;
  };
  platform: string;
  engines: {
    id: string;
    title: string;
    description: string;
    backend: string;
  }[];
  runtimes: {
    backend: string;
    state: string;
    size: number | null;
    done?: number;
    total?: number;
    error?: string | null;
  }[];
  models: Model[];
  languages: { value: string; label: string }[];
}

/** A size as people read it. */
function bytes(size: number) {
  if (size < 1e6) return `${Math.max(1, Math.round(size / 1e3))} KB`;
  if (size < 1e9) return `${Math.round(size / 1e6)} MB`;
  return `${(size / 1e9).toFixed(1)} GB`;
}

const ACCELERATION: Record<string, string> = {
  metal: "Metal",
  cuda: "CUDA",
  vulkan: "Vulkan",
  cpu: "Processor",
};

const KEEP = [
  { value: "0", label: "Always" },
  { value: "5", label: "5 minutes without use" },
  { value: "15", label: "15 minutes without use" },
  { value: "60", label: "1 hour without use" },
];

/** A model's state, in a few words. */
function stateOf(model: Model) {
  switch (model.state) {
    case "ready":
      return "Downloaded";
    case "downloading":
      return model.total
        ? `${Math.floor(((model.done ?? 0) / model.total) * 100)}%`
        : "Downloading";
    case "failed":
      return "Failed";
    default:
      return "";
  }
}

/**
 * Voice's settings: the engine and model that hear, downloaded and deleted here; what is
 * loaded, on which acceleration and with how much memory; the language, the names to write
 * right, silence detection, and how long the model stays loaded.
 */
export default function VoiceSettings() {
  const read = useActionResult<Settings>("settings", {});
  useEvent("changed", () => void read.reload());
  const configure = useAction("configure");
  const download = useAction("download");
  const cancel = useAction("cancel");
  const remove = useAction("delete_model");
  const install = useAction("install_runtime");
  const load = useAction("load");
  const unload = useAction("unload");
  const settings = read.data;
  const [engine, setEngine] = useState("");
  const [words, setWords] = useState<string>();
  useEffect(() => {
    if (settings && !engine) setEngine(settings.config.engine);
  }, [settings, engine]);
  if (!settings)
    return read.error ? <Text tone="danger">{read.error}</Text> : <Spinner />;

  const { config, status } = settings;
  const after = (work: Promise<unknown>) =>
    void work.then(
      () => read.reload(),
      () => {},
    );
  const set = (change: Record<string, unknown>) => after(configure.run(change));
  const shown = engine || config.engine;
  const current = settings.models.find((model) => model.id === config.model);
  const loaded = settings.models.find((model) => model.id === status.model);
  const about = settings.engines.find((each) => each.id === shown);
  const error =
    read.error ||
    configure.error ||
    download.error ||
    cancel.error ||
    remove.error ||
    install.error ||
    load.error ||
    unload.error;

  const menu = (model: Model): MenuEntry[] => [
    ...(model.id === config.model
      ? []
      : [
          {
            title: model.state === "ready" ? "Use" : "Download and use",
            icon: "check",
            onPress: () => set({ model: model.id }),
          },
        ]),
    ...(model.state === "absent" || model.state === "failed"
      ? [
          {
            title: "Download",
            icon: "download",
            onPress: () => after(download.run({ model: model.id })),
          },
        ]
      : []),
    ...(model.state === "downloading"
      ? [
          {
            title: "Cancel download",
            icon: "x",
            onPress: () => after(cancel.run({ model: model.id })),
          },
        ]
      : []),
    ...(model.state === "ready" && model.id !== config.model
      ? [
          { divider: true as const },
          {
            title: "Delete",
            icon: "trash-2",
            tone: "danger" as const,
            onPress: () => after(remove.run({ model: model.id })),
          },
        ]
      : []),
  ];

  const rows: TableRow[] = settings.models
    .filter((model) => model.engine === shown)
    .map((model) => ({
      id: model.id,
      icon: "audio-lines",
      cells: {
        model: (
          <Stack direction="row" gap={8} align="center">
            <Text>{model.title}</Text>
            <Text tone="muted" size="sm">
              {model.variant}
            </Text>
            {model.id === config.model ? (
              <Badge tone="success">In use</Badge>
            ) : null}
          </Stack>
        ),
        languages: <Text tone="muted">{model.languages}</Text>,
        size: (
          <Text tone="muted" mono>
            {bytes(model.size)}
          </Text>
        ),
        memory: (
          <Text tone="muted" mono>
            {bytes(model.memory)}
          </Text>
        ),
        state: (
          <Text tone={model.state === "failed" ? "danger" : "muted"}>
            {model.state === "failed"
              ? (model.error ?? "Failed")
              : stateOf(model)}
          </Text>
        ),
      },
      onOpen:
        model.id === config.model ? undefined : () => set({ model: model.id }),
      menu: menu(model),
    }));

  return (
    <Stack gap={20}>
      {error ? <Text tone="danger">{error}</Text> : null}
      <Section
        title="Transcription"
        actions={
          status.state === "loaded" ? (
            <Button
              title="Unload"
              variant="ghost"
              busy={unload.busy}
              onPress={() => after(unload.run({}))}
            />
          ) : (
            <Button
              title="Load"
              variant="secondary"
              busy={load.busy || status.state === "loading"}
              disabled={current?.state !== "ready"}
              onPress={() => after(load.run({}))}
            />
          )
        }
      >
        <Stack direction="row" gap={8} align="center">
          <Icon
            name="audio-lines"
            tone={status.state === "loaded" ? "success" : "muted"}
          />
          <Text>
            {status.state === "loading"
              ? `Loading ${current?.title ?? ""}`
              : status.state === "loaded" && loaded
                ? `${loaded.title} ${loaded.variant}`
                : "Not loaded"}
          </Text>
          {status.state === "loaded" && status.backend ? (
            <Badge>{ACCELERATION[status.backend] ?? status.backend}</Badge>
          ) : null}
          {status.state === "loaded" && status.memory ? (
            <Text tone="muted" mono size="sm">
              {bytes(status.memory)}
            </Text>
          ) : null}
        </Stack>
        {status.error ? <Text tone="danger">{status.error}</Text> : null}
        {current && current.state !== "ready" ? (
          <Text tone="muted">
            {current.state === "downloading"
              ? `Downloading ${current.title} ${current.variant}: ${stateOf(current)}`
              : `${current.title} ${current.variant} is not downloaded`}
          </Text>
        ) : null}
      </Section>

      <Section title="Engine">
        <Tabs
          items={settings.engines.map((each) => ({
            value: each.id,
            label: each.title,
          }))}
          value={shown}
          onChange={setEngine}
        />
        {about ? (
          <Text tone="muted" size="sm">
            {about.description}
          </Text>
        ) : null}
        {shown === "whisper.cpp" ? (
          <Stack gap={6}>
            {settings.runtimes.map((runtime) => (
              <Stack
                key={runtime.backend}
                direction="row"
                gap={8}
                align="center"
              >
                <Text>{ACCELERATION[runtime.backend] ?? runtime.backend}</Text>
                <Text
                  tone={runtime.state === "failed" ? "danger" : "muted"}
                  size="sm"
                >
                  {runtime.state === "ready"
                    ? "Installed"
                    : runtime.state === "downloading"
                      ? runtime.total
                        ? `${Math.floor(((runtime.done ?? 0) / runtime.total) * 100)}%`
                        : "Downloading"
                      : runtime.state === "unavailable"
                        ? "Not available yet"
                        : runtime.state === "failed"
                          ? (runtime.error ?? "Failed")
                          : runtime.size
                            ? bytes(runtime.size)
                            : ""}
                </Text>
                {runtime.state === "absent" || runtime.state === "failed" ? (
                  <Button
                    title="Install"
                    variant="secondary"
                    busy={install.busy}
                    onPress={() =>
                      after(install.run({ backend: runtime.backend }))
                    }
                  />
                ) : null}
              </Stack>
            ))}
          </Stack>
        ) : null}
        <Table
          columns={[
            { key: "model", title: "Model" },
            { key: "languages", title: "Languages" },
            { key: "size", title: "Download", align: "end" },
            { key: "memory", title: "Memory", align: "end" },
            { key: "state", title: "State" },
          ]}
          rows={rows}
          empty="No models"
        />
      </Section>

      <Section title="Hearing">
        <Select
          label="Language"
          value={config.language}
          options={settings.languages}
          onChange={(language) => set({ language })}
        />
        {config.engine !== "parakeet" ? (
          <Switch
            label="Skip silence"
            value={config.vad}
            onChange={(vad) => set({ vad })}
          />
        ) : null}
        <Select
          label="Keep the model loaded"
          value={String(config.keep)}
          options={KEEP}
          onChange={(keep) => set({ keep: Number(keep) })}
        />
        {current?.vocabulary !== false ? (
          <Stack gap={6}>
            <Input
              label="Words to write right"
              value={words ?? config.vocabulary.join(", ")}
              onChange={setWords}
              placeholder="ZeroLux, Kubernetes, Ines"
              onSubmit={() =>
                words !== undefined &&
                set({
                  vocabulary: words.split(",").map((word) => word.trim()),
                })
              }
            />
            {words !== undefined && words !== config.vocabulary.join(", ") ? (
              <Button
                title="Save"
                variant="secondary"
                busy={configure.busy}
                onPress={() =>
                  set({
                    vocabulary: words.split(",").map((word) => word.trim()),
                  })
                }
              />
            ) : null}
          </Stack>
        ) : null}
      </Section>
    </Stack>
  );
}
