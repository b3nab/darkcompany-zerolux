import * as React from "react";
import { Component, useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { ActivityIndicator } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  activeActors,
  errorMessage,
  pieceUrl,
  useExtensions,
} from "@zerolux/chat";
import type { UiContext, UiPiece } from "@zerolux/chat";
import { moduleHost, uiModule, UiSpace } from "@zerolux/ui/host";
import { saveFile } from "@/components/save-file";
import { Text } from "@/components/ui/text";
import { uiComponents } from "@/components/ui-components";
import { useSession } from "../src/kernel";

// The bundle running now, by its address: its view is kept by that name.
let running: string | undefined;
const host = moduleHost(
  {
    react: React,
    "react/jsx-runtime": JsxRuntime,
    "@zerolux/ui": uiModule(uiComponents),
  },
  () => running,
);

/** A view's bundle, run by the app's own engine: the view it gives. */
async function loadView(address: string) {
  const source = await (await fetch(address)).text();
  running = address;
  try {
    // Indirect: it runs in the global scope, as a script, with nothing of this module.
    (0, eval)(source);
  } finally {
    running = undefined;
  }
  const view = host.view(address);
  if (!view) throw new Error("This view's bundle gives no view");
  return view;
}

/** A view that breaks shows why, in its place, and the rest of the app goes on. */
class Contained extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }
  render() {
    return this.state.error ? (
      <Text className="text-sm text-destructive">{this.state.error}</Text>
    ) : (
      this.props.children
    );
  }
}

/**
 * An extension's native view, from its package: written with `@zerolux/ui`, drawn with the
 * app's own components, run inside the app with the person's access.
 */
export function NativeView({
  piece,
  context,
}: {
  piece: UiPiece;
  context: UiContext;
}) {
  const { url, workspace } = useSession();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  // Loaded again when its extension changes, not each time the list is read again: a view
  // loaded anew starts over, and what was typed in it would go.
  const { extensions } = useExtensions(url);
  const revision = extensions?.find(
    (e) => e.id === piece.extension,
  )?.updated_at;
  const entry = piece.view.kind === "native" ? piece.view.entry : undefined;
  const [loaded, setLoaded] = useState<{
    view?: ComponentType;
    error?: string;
  }>({});
  useEffect(() => {
    let shown = true;
    if (revision === undefined) return;
    pieceUrl(piece, url)
      .then(loadView)
      .then(
        (view) => shown && setLoaded({ view }),
        (e: unknown) => shown && setLoaded({ error: errorMessage(e) }),
      );
    return () => {
      shown = false;
    };
    // The piece is read for what it names, not for being a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piece.extension, entry, url, revision]);
  if (loaded.error)
    return <Text className="text-sm text-destructive">{loaded.error}</Text>;
  if (!loaded.view)
    return (
      <ActivityIndicator size="small" color={muted} className="self-start" />
    );
  const View = loaded.view;
  return (
    <Contained>
      <UiSpace
        piece={piece}
        context={context}
        kernel={url}
        save={saveFile}
        actors={activeActors(workspace?.actors ?? [])}
      >
        <View />
      </UiSpace>
    </Contained>
  );
}
