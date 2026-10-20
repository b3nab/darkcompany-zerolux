import { useEffect, useState } from "react";
import {
  ago,
  createInvite,
  errorMessage,
  inviteLink,
  kernelUrl,
  listInvites,
  withdrawInvite,
} from "@zerolux/chat";
import type { Invite, Perform } from "@zerolux/chat";
import { Copy } from "@/components/tool-call";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** An address only this computer reaches: nobody else comes in through it. */
export const onlyHere = (address: string) =>
  /^https?:\/\/(localhost|127\.|\[::1\])/.test(address);

/**
 * The owner's invitations: a link brings one person in, once, within seven days, with their own
 * account; the links nobody used yet, each withdrawn at will.
 */
export function InvitePeople({
  open,
  close,
  busy,
  perform,
}: {
  open: boolean;
  close: () => void;
  busy: boolean;
  perform: Perform;
}) {
  const [invites, setInvites] = useState<Invite[]>();
  const [error, setError] = useState("");
  // The link of the invitation just made: its token is shown only now.
  const [link, setLink] = useState<string>();
  // The address people reach this workspace at: the kernel's, or this page's.
  const address = kernelUrl() || (globalThis.location?.origin ?? "");
  useEffect(() => {
    if (!open) return;
    listInvites().then(setInvites, (failed: unknown) =>
      setError(errorMessage(failed)),
    );
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setLink(undefined);
        close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {link ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Invitation link"
                value={link}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-[12.5px]"
              />
              <Copy text={link} className="opacity-100" />
            </div>
            <p className="text-xs text-faint">Shown only once.</p>
            {onlyHere(address) && (
              <p className="text-xs text-attention">
                This link works only on this computer; open ZeroLux at an
                address others can reach.
              </p>
            )}
          </div>
        ) : (
          <Button
            className="self-start"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const { invite, token } = await createInvite();
                setLink(inviteLink(address, token));
                setInvites((all) => [...(all ?? []), invite]);
              })
            }
          >
            Make an invitation link
          </Button>
        )}
        {!!invites?.length && (
          <section aria-label="Waiting invitations" className="flex flex-col">
            <h3 className="mb-1 font-mono text-[11px] tracking-wide text-faint uppercase">
              Not used yet · {invites.length}
            </h3>
            <ul className="flex flex-col divide-y">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    Made {ago(invite.created_at)} · until{" "}
                    {new Date(invite.expires_at).toLocaleDateString([], {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await withdrawInvite(invite.id);
                        setInvites((all) =>
                          all?.filter((one) => one.id !== invite.id),
                        );
                      })
                    }
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
