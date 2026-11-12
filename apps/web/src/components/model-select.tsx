import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  agentModelValue,
  settingChoices,
  type AgentModelOption,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** The harness's choices, or a model ID it accepts; typing never changes the session. */
export function ModelSelect({
  id,
  value,
  models,
  custom,
  disabled,
  none,
  onChange,
  onOpen,
}: {
  id?: string;
  value: string;
  models: AgentModelOption[];
  custom?: boolean;
  disabled?: boolean;
  none?: string;
  onChange(value: string): void;
  onOpen(): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = Object.fromEntries(
    models.map((model) => [model.value, model.label]),
  );
  const selected = agentModelValue(models, value);
  const choices = settingChoices(options, search, custom);
  const choose = (next: string) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSearch("");
          onOpen();
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            className="w-full justify-between font-normal"
            aria-label="Model"
          />
        }
      >
        <span className="truncate">
          {options[selected] ?? (value || none || "Model")}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            disabled={disabled}
            value={search}
            onValueChange={setSearch}
            placeholder={
              custom ? "Search or enter a model ID" : "Search models"
            }
            aria-label="Model"
          />
          <CommandList>
            {none && !search && (
              <CommandItem
                value=""
                disabled={disabled}
                data-checked={!selected}
                onSelect={() => choose("")}
              >
                {none}
              </CommandItem>
            )}
            {choices.map((choice) => (
              <CommandItem
                key={choice.value}
                value={choice.value}
                disabled={disabled}
                data-checked={selected === choice.value}
                onSelect={() => choose(choice.value)}
              >
                {choice.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
