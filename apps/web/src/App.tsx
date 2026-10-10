import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router";
import { BellIcon, MenuIcon, SearchIcon } from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import { useChat, useStorage } from "@zerolux/chat";
import type { Conversation } from "@zerolux/chat";
import { activeActors, api, errorMessage } from "./api";
import {
  trafficLightsInset,
  windowDragProps,
  workspaceNavigationGuard,
} from "./desktop";
import { WindowControls } from "@/components/window-controls";
import { cn } from "cn";
import type { Actor, Workspace } from "./api";
import { Approvals } from "./Approvals";
import { ChatHome, ChatList, ChatView, NewConversation } from "./ChatView";
import { CommandMenu } from "./CommandMenu";
import { MD, useMedia } from "./media";
import { Meetings } from "./Meetings";
import { OwnerOnboarding } from "./OwnerOnboarding";
import { Organization } from "./Org";
import { ProjectPage } from "./Projects";
import { AgentList, ProjectList, Sidebar, WorkspaceMenu } from "./Sidebar";
import type { Kernel } from "./Sidebar";
import { Storage } from "./Storage";
import { Hire, Team } from "./Team";
import { Tonight } from "./Tonight";
import { Page } from "@/components/page";
import { SidePanel } from "@/components/side-panel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

type Health = { version: string; capabilities: string[] };

export function App({
  initialWorkspace = null,
  initialHealth,
}: {
  initialWorkspace?: Workspace | null;
  initialHealth?: Health;
} = {}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(
    initialWorkspace,
  );
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(initialHealth);
  const [menu, setMenu] = useState(false);
  const [rail, setRail] = useState(false);
  const wide = useMedia(MD);
  // The open section's panel: ⌘B and the section's icon open and close it.
  const side = usePanelRef();
  const toggle = useCallback(() => {
    const panel = side.current;
    if (!panel) return false;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
    return true;
  }, [side]);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const chatId = useMatch("/chats/:id")?.params.id;
  const projectPath = useMatch("/projects/:id?");
  const requestId = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    const data = await api<Workspace>("/workspace", undefined, signal);
    if (!signal?.aborted && id === requestId.current) {
      setWorkspace(data);
      setConnectionError("");
    }
  }, []);

  useEffect(() => {
    // The kernel says what it can do and which version it is; the UI follows.
    api<Health>("/health").then(setHealth, () => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(errorMessage(error));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setMenu((open) => !open);
      } else if (key === "b" && toggle()) e.preventDefault();
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [toggle]);
  // A page opened from the rail on a phone closes it.
  useEffect(() => setRail(false), [pathname]);

  const project =
    workspace?.projects.find((p) => p.id === projectPath?.params.id) ??
    workspace?.projects[0];
  const actors = activeActors(workspace?.actors ?? []);
  const needsOnboarding = workspace?.onboarding_required === true;
  const owner = actors.find((a) => a.kind === "human");
  // Hide chat only when the kernel answers without it (an older kernel).
  const chatReady = health?.capabilities.includes("chat-v1") ?? true;
  const capabilities = health?.capabilities ?? [];
  const chat = useChat(!!workspace && !needsOnboarding && chatReady);
  useEffect(() => workspaceNavigationGuard(chat.canLeave), [chat.canLeave]);
  // One list of files for the whole app: storage page, chats, their panels.
  const storage = useStorage(capabilities.includes("storage-v1"));
  const conversation = chat.conversations.find((c) => c.id === chatId);
  useEffect(() => {
    // The open chat follows the address, also once the chat list has loaded.
    if (conversation?.id !== chat.openId) chat.select(conversation);
    // chat.select only uses refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, chat.openId]);
  const hire = () => navigate("/team/hire");
  const showChat = (c: Conversation) => navigate(`/chats/${c.id}`);
  const kernel: Kernel = {
    ...(connectionError
      ? { tone: "attention", label: "Kernel offline" }
      : !workspace
        ? { tone: "connecting", label: "Connecting…" }
        : chat.realtime === "live"
          ? { tone: "connected", label: "Kernel · live" }
          : needsOnboarding || chat.realtime === "connecting"
            ? { tone: "connecting", label: "Kernel" }
            : { tone: "stopped", label: "Kernel · realtime offline" }),
    host: globalThis.location?.host ?? "",
    version: health?.version,
  };

  async function perform(operation: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await operation();
      // Done is done: a refresh that fails (kernel restarting) is not a failed action.
      await refresh().catch(() => {});
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const pending = chat.approvals.filter((a) => a.status === "pending").length;
  const approvals = workspace && (
    <Approvals
      chat={chat}
      actors={workspace.actors}
      busy={busy}
      perform={perform}
      show={showChat}
    />
  );
  const nothingWaits = (
    <p className="text-sm text-muted-foreground">
      Nothing waits for you. The agents ask here when they need you.
    </p>
  );
  /** A section's page with its list beside it; on a phone, the list until something is open. */
  const section = (list: ReactNode, open: boolean, page: ReactNode) =>
    wide ? (
      <SidePanel
        id="section"
        wide
        side="start"
        panel={list}
        size={288}
        min={208}
        max={480}
        collapsible
        panelRef={side}
      >
        {page}
      </SidePanel>
    ) : open ? (
      page
    ) : (
      list
    );
  const chatList = <ChatList chat={chat} actors={actors} />;
  const chatHome = section(
    chatList,
    false,
    <Page>
      <ChatHome
        chat={chat}
        hire={hire}
        newChat={() => navigate("/chats/new")}
      />
    </Page>,
  );
  const projectPage = workspace && (
    <ProjectPage
      key={project?.id}
      workspace={workspace}
      project={project}
      busy={busy}
      perform={perform}
      hire={hire}
    />
  );
  const projectList = workspace && (
    <ProjectList workspace={workspace} busy={busy} perform={perform} />
  );
  const agentList = workspace && owner && (
    <AgentList workspace={workspace} chat={chat} owner={owner} />
  );
  const shell = !!workspace && !!owner && !needsOnboarding && chatReady;
  const sidebar = shell && (
    <Sidebar chat={chat} owner={owner} kernel={kernel} toggle={toggle} />
  );
  // In the macOS desktop app the header is the window's title bar: it spans the window,
  // with the native traffic lights in its first 92px, and the rail starts below it.
  const titleBar = trafficLightsInset();

  return (
    <div
      data-rail={shell || undefined}
      className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] md:data-rail:grid-cols-[4.25rem_minmax(0,1fr)]"
    >
      {sidebar && (
        <aside
          className={cn(
            "flex min-h-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar max-md:hidden",
            titleBar ? "row-start-2" : "row-span-2",
          )}
        >
          {sidebar}
        </aside>
      )}
      {/* Three columns, so the search sits in the middle whatever the sides hold; a phone has no middle. */}
      <header
        {...windowDragProps()}
        className={cn(
          "grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b pr-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:pr-4",
          titleBar
            ? "col-span-full pl-23"
            : cn("pl-3 md:pl-4", shell && "md:col-start-2"),
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {shell && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open the menu"
              className="md:hidden"
              onClick={() => setRail(true)}
            >
              <MenuIcon />
            </Button>
          )}
          {shell ? (
            <WorkspaceMenu
              workspace={workspace}
              busy={busy}
              perform={perform}
            />
          ) : (
            <h1 className="truncate text-sm font-semibold">ZeroLux</h1>
          )}
        </div>
        {shell ? (
          <button
            type="button"
            onClick={() => setMenu(true)}
            className="flex h-8 w-[min(30rem,40vw)] items-center gap-2 rounded-md border border-input bg-card px-2.5 text-[13px] text-faint transition-colors hover:border-faint/60 hover:text-muted-foreground max-md:hidden"
          >
            <SearchIcon aria-hidden className="size-3.5" />
            Search or run
            <KbdGroup className="ml-auto">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </button>
        ) : (
          <span className="max-md:hidden" />
        )}
        <div className="flex items-center justify-end gap-1">
          {shell && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search or run"
              className="md:hidden"
              onClick={() => setMenu(true)}
            >
              <SearchIcon />
            </Button>
          )}
          {shell ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      pending ? `${pending} requests wait for you` : "Requests"
                    }
                    className="relative"
                  />
                }
              >
                <BellIcon />
                {pending > 0 && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-human shadow-[0_0_6px_var(--color-human)]"
                  />
                )}
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="max-h-[70vh] w-96 overflow-y-auto"
              >
                {pending ? approvals : nothingWaits}
              </PopoverContent>
            </Popover>
          ) : (
            <span
              role="status"
              className="font-mono text-[11px] text-muted-foreground"
            >
              {kernel.label}
              {kernel.version && ` · v${kernel.version}`}
            </span>
          )}
          <WindowControls />
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-col">
        {(error || connectionError || (chat.error && !projectPath)) && (
          <div
            role="alert"
            className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:px-6"
          >
            {error || connectionError || chat.error}
          </div>
        )}
        <main className="flex min-h-0 flex-1 flex-col">
          {!workspace ? (
            <Page>
              <h1 className="text-3xl font-light tracking-tight">
                Connecting to your kernel
              </h1>
              <p className="text-muted-foreground">
                Start the Rust server with{" "}
                <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-sm">
                  cargo run -- serve
                </code>
                .
              </p>
            </Page>
          ) : needsOnboarding ? (
            <Page>
              <OwnerOnboarding
                busy={busy}
                save={(name) =>
                  perform(async () => {
                    await api<Actor>("/onboarding/owner", { name });
                  })
                }
              />
            </Page>
          ) : !owner ? null : !chatReady ? (
            projectPage
          ) : (
            <Routes>
              <Route
                path="/"
                element={
                  <Tonight
                    workspace={workspace}
                    chat={chat}
                    owner={owner}
                    busy={busy}
                    perform={perform}
                    capabilities={capabilities}
                  />
                }
              />
              <Route path="/chats" element={chatHome} />
              <Route
                path="/chats/new"
                element={section(
                  chatList,
                  true,
                  <Page>
                    <NewConversation
                      chat={chat}
                      actors={actors}
                      ownerId={owner.id}
                      busy={busy}
                      perform={perform}
                      open={showChat}
                      hire={hire}
                    />
                  </Page>,
                )}
              />
              <Route
                path="/chats/:id"
                element={
                  conversation
                    ? section(
                        chatList,
                        true,
                        <ChatView
                          key={conversation.id}
                          chat={chat}
                          conversation={conversation}
                          actors={workspace.actors}
                          ownerId={owner.id}
                          busy={busy}
                          perform={perform}
                          hire={hire}
                          storage={storage}
                          capabilities={capabilities}
                        />,
                      )
                    : chatHome
                }
              />
              <Route
                path="/storage"
                element={
                  <Storage
                    workspace={workspace}
                    chat={chat}
                    storage={storage}
                  />
                }
              />
              <Route
                path="/org"
                element={<Organization workspace={workspace} chat={chat} />}
              />
              <Route
                path="/meetings"
                element={
                  <Meetings
                    workspace={workspace}
                    chat={chat}
                    owner={owner}
                    capabilities={capabilities}
                  />
                }
              />
              <Route
                path="/approvals"
                element={
                  <Page>
                    {chat.approvals.length ? approvals : nothingWaits}
                  </Page>
                }
              />
              <Route
                path="/team"
                element={section(
                  agentList,
                  true,
                  <Page>
                    <Team
                      chat={chat}
                      actors={workspace.actors}
                      busy={busy}
                      perform={perform}
                      hire={hire}
                    />
                  </Page>,
                )}
              />
              <Route
                path="/team/hire"
                element={section(
                  agentList,
                  true,
                  <Page>
                    <Hire
                      chat={chat}
                      actors={workspace.actors}
                      busy={busy}
                      perform={perform}
                    />
                  </Page>,
                )}
              />
              <Route
                path="/projects/:id?"
                element={section(
                  projectList,
                  !!projectPath?.params.id,
                  projectPage,
                )}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
      {shell && (
        <>
          <Sheet open={rail} onOpenChange={setRail}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[4.25rem] gap-0 overflow-y-auto bg-sidebar"
            >
              <SheetTitle className="sr-only">Menu</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
          <CommandMenu
            open={menu}
            setOpen={setMenu}
            workspace={workspace}
            chat={chat}
            perform={perform}
          />
        </>
      )}
    </div>
  );
}
