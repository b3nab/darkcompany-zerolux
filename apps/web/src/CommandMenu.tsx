import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  FolderIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  MoonIcon,
  NetworkIcon,
  PhoneIcon,
  PlusIcon,
  RefreshCwIcon,
  StampIcon,
  SunIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import {
  errorMessage,
  harnessLabels,
  homeLabel,
  isThread,
} from "@zerolux/chat";
import type { Chat, Discovery, Perform } from "@zerolux/chat";
import type { Workspace } from "./api";
import { useTheme } from "./theme";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

// The home's name follows the hour; ⌘K finds it by either name.
const pages = () => [
  {
    to: "/",
    label: homeLabel(),
    value: "Tonight Today",
    icon: LayoutDashboardIcon,
  },
  { to: "/chats", label: "Chat", icon: MessagesSquareIcon },
  { to: "/storage", label: "Storage", icon: FolderIcon },
  { to: "/org", label: "Org", icon: NetworkIcon },
  { to: "/meetings", label: "Meetings", icon: PhoneIcon },
  { to: "/approvals", label: "Approvals", icon: StampIcon },
  { to: "/team", label: "Team", icon: UsersIcon },
];

/** ⌘K: go anywhere, open a chat or project, hire a running session, run an action. */
export function CommandMenu({
  open,
  setOpen,
  workspace,
  chat,
  perform,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: Workspace;
  chat: Chat;
  perform: Perform;
}) {
  const navigate = useNavigate();
  const { resolved, choose } = useTheme();
  const [discovery, setDiscovery] = useState<Discovery>();
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState("");

  async function look() {
    setLooking(true);
    try {
      setDiscovery(await chat.discover());
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLooking(false);
    }
  }
  useEffect(() => {
    // The sessions on this machine are looked up each time the menu opens, never on a timer.
    if (open) void look();
    // look only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const hired = (harness: string, nativeId: string) =>
    chat.sessions.some(
      (s) =>
        s.status !== "stopped" &&
        s.harness === harness &&
        s.native_session_id === nativeId,
    );
  const sessions = (discovery?.sessions ?? [])
    .filter((d) => !hired(d.harness, d.native_session_id))
    .sort(
      (a, b) =>
        Number(b.availability === "attachable") -
          Number(a.availability === "attachable") ||
        (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
    );
  const chats = chat.conversations.filter((c) => !isThread(c));

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search or run a command"
      description="Go to a page, open a chat or project, hire a running session."
      className="sm:max-w-160"
    >
      <Command>
        <CommandInput placeholder="Search or run a command" />
        <CommandList className="max-h-[min(28rem,60vh)]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            {pages().map(({ to, label, value, icon: Icon }) => (
              <CommandItem
                key={to}
                value={value ?? label}
                onSelect={() => run(() => navigate(to))}
              >
                <Icon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
          {chats.length > 0 && (
            <CommandGroup heading="Chats">
              {chats.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`chat ${c.title} ${c.id}`}
                  onSelect={() => run(() => navigate(`/chats/${c.id}`))}
                >
                  <MessagesSquareIcon />
                  {c.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {workspace.projects.length > 0 && (
            <CommandGroup heading="Projects">
              {workspace.projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`project ${p.name} ${p.id}`}
                  onSelect={() => run(() => navigate(`/projects/${p.id}`))}
                >
                  <FolderIcon />
                  {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Hire a running session">
            {sessions.map((d) => {
              const ready = d.availability === "attachable";
              return (
                <CommandItem
                  key={d.id}
                  value={`hire ${d.title} ${harnessLabels[d.harness]} ${d.workspace} ${d.id}`}
                  disabled={!ready}
                  onSelect={() =>
                    run(
                      () =>
                        void perform(async () => {
                          await chat.hire(
                            d.id,
                            d.title || harnessLabels[d.harness],
                          );
                          navigate("/team");
                        }),
                    )
                  }
                  className="items-start py-2"
                >
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-[22%] border border-input bg-secondary font-mono text-[10px]"
                  >
                    {d.harness === "claude-code"
                      ? "CC"
                      : d.harness === "codex"
                        ? "CX"
                        : "pi"}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium">
                      {d.title || "Untitled session"}
                    </span>
                    <span
                      data-attention={!ready || undefined}
                      className="truncate font-mono text-[11px] text-faint data-attention:text-attention"
                    >
                      {harnessLabels[d.harness]} ·{" "}
                      {ready
                        ? d.workspace
                        : (d.reason ?? "Cannot be connected right now")}
                    </span>
                  </span>
                  {ready && <CommandShortcut>Hire ↵</CommandShortcut>}
                </CommandItem>
              );
            })}
            <CommandItem
              value="look for sessions again"
              onSelect={() => void look()}
            >
              <RefreshCwIcon />
              {looking
                ? "Looking for sessions…"
                : error
                  ? `Could not look: ${error}`
                  : sessions.length
                    ? "Look for sessions again"
                    : "No sessions to hire. Look again"}
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(() => navigate("/chats/new"))}>
              <PlusIcon />
              New chat
            </CommandItem>
            <CommandItem onSelect={() => run(() => navigate("/team/hire"))}>
              <UserPlusIcon />
              Hire an agent
            </CommandItem>
            <CommandItem
              onSelect={() =>
                run(() => choose(resolved === "dark" ? "light" : "dark"))
              }
            >
              {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
              {resolved === "dark" ? "Daylight theme" : "Night theme"}
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <footer className="flex items-center gap-4 border-t px-4 py-2.5 font-mono text-[11px] text-faint">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </footer>
      </Command>
    </CommandDialog>
  );
}
