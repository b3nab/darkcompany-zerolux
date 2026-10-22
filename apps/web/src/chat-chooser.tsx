import { createContext, useCallback, useContext, useState } from "react";
import { SearchIcon } from "lucide-react";
import { listChats } from "@zerolux/chat";
import type { Conversation } from "@zerolux/chat";
import { ChatMark } from "./ChatView";
import { UiActors } from "./native-ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** The person's chats, for a view that shares something in one. */
export const UiChats = createContext<Conversation[]>([]);

/**
 * The app's own list of chats, asked for by a view under a title: what it gives answers with the
 * chat chosen, or null when the list is closed.
 */
export function useChatChooser() {
  const chats = useContext(UiChats);
  const actors = useContext(UiActors);
  const [asked, setAsked] = useState<{
    title: string;
    answer: (id: string | null) => void;
  }>();
  const [query, setQuery] = useState("");
  const choose = useCallback(
    (title: string) =>
      new Promise<string | null>((answer) => {
        setQuery("");
        setAsked({ title, answer });
      }),
    [],
  );
  const close = (id: string | null) => {
    asked?.answer(id);
    setAsked(undefined);
  };
  const words = query.trim().toLowerCase();
  const shown = listChats(chats, "all", new Set()).filter(
    (c) => !words || c.title.toLowerCase().includes(words),
  );
  const list = asked && (
    <Dialog open onOpenChange={(open) => !open && close(null)}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{asked.title}</DialogTitle>
        </DialogHeader>
        <label className="flex h-9 items-center gap-2 rounded-md border border-input px-2.5 text-faint focus-within:border-ring">
          <SearchIcon className="size-4" />
          <input
            autoFocus
            aria-label="Search chats"
            placeholder="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
          />
        </label>
        <ul className="-mx-2 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {shown.length ? (
            shown.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => close(c.id)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <ChatMark
                    conversation={c}
                    actors={actors}
                    className="size-8"
                  />
                  <span className="truncate">{c.title}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-2 py-3 text-sm text-muted-foreground">
              No chats
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
  return [choose, list] as const;
}
