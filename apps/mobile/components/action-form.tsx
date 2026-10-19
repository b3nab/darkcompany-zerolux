import { Pressable, Switch, View } from "react-native";
import type { ActionDraft, ActionDrafts, ActionField } from "@zerolux/chat";
import { Choice } from "@/components/choice";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/**
 * The fields of an action's input, drawn with the app's own components: each with its label,
 * its description and what is wrong in it. The form's state is `useActionForm`'s.
 */
export function ActionForm({
  fields,
  drafts,
  errors,
  set,
  disabled = false,
}: {
  fields: ActionField[];
  drafts: ActionDrafts;
  errors: Record<string, string>;
  set: (key: string, draft: ActionDraft) => void;
  disabled?: boolean;
}) {
  return (
    <View className="gap-5">
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          drafts={drafts}
          errors={errors}
          set={set}
          disabled={disabled}
        />
      ))}
    </View>
  );
}

function Field({
  field,
  drafts,
  errors,
  set,
  disabled,
}: {
  field: ActionField;
  drafts: ActionDrafts;
  errors: Record<string, string>;
  set: (key: string, draft: ActionDraft) => void;
  disabled: boolean;
}) {
  const draft = drafts[field.key];
  const error = errors[field.key];
  const label = `${field.label}${field.required ? "" : " (optional)"}`;
  const text = typeof draft === "string" ? draft : "";
  const typed = (props: Partial<React.ComponentProps<typeof Input>> = {}) => (
    <Input
      value={text}
      onChangeText={(next) => set(field.key, next)}
      editable={!disabled}
      autoCapitalize="none"
      autoCorrect={false}
      aria-invalid={Boolean(error)}
      {...props}
    />
  );
  const control = (() => {
    switch (field.kind) {
      case "boolean":
        return null;
      case "group":
        return (
          <View className="border-l-2 border-border pl-3.5">
            <ActionForm
              fields={field.fields!}
              drafts={drafts}
              errors={errors}
              set={set}
              disabled={disabled}
            />
          </View>
        );
      case "choice":
        return (
          <Choice
            label={label}
            options={Object.fromEntries(
              field.options!.map((option, index) => [String(index), option]),
            )}
            value={text}
            onChange={(next) => set(field.key, next)}
            none={field.required ? undefined : "None"}
            disabled={disabled}
          />
        );
      case "choices": {
        const chosen = Array.isArray(draft) ? draft : [];
        return (
          <View className="flex-row flex-wrap gap-1.5">
            {field.options!.map((option, index) => {
              const key = String(index);
              const on = chosen.includes(key);
              return (
                <Pressable
                  key={key}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled }}
                  disabled={disabled}
                  onPress={() =>
                    set(
                      field.key,
                      on ? chosen.filter((k) => k !== key) : [...chosen, key],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1",
                    on ? "border-human bg-human/10" : "border-border",
                    disabled && "opacity-50",
                  )}
                >
                  <Text className="text-xs">{option}</Text>
                </Pressable>
              );
            })}
          </View>
        );
      }
      case "number":
        return typed({ keyboardType: "decimal-pad" });
      case "integer":
        return typed({ keyboardType: "number-pad" });
      case "secret":
        return typed({ secureTextEntry: true, className: "font-mono" });
      case "list":
        return typed({
          multiline: true,
          placeholder: "One per line",
          className: "h-auto min-h-20 py-2",
        });
      case "json":
        return typed({
          multiline: true,
          placeholder: "JSON",
          className: "h-auto min-h-24 py-2 font-mono text-[13px]",
        });
      default:
        return typed(
          field.multiline
            ? {
                multiline: true,
                autoCapitalize: "sentences",
                autoCorrect: true,
                className: "h-auto min-h-24 py-2",
              }
            : { autoCapitalize: "sentences", autoCorrect: true },
        );
    }
  })();
  return (
    <View className="gap-2">
      {field.kind === "boolean" ? (
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-sm font-medium">{field.label}</Text>
          <Switch
            accessibilityLabel={field.label}
            value={draft === true}
            onValueChange={(on) => set(field.key, on)}
            disabled={disabled}
          />
        </View>
      ) : field.kind === "choice" ? null : (
        <Text className="text-sm font-medium">{label}</Text>
      )}
      {control}
      {field.description ? (
        <Text className="text-xs text-muted-foreground">
          {field.description}
        </Text>
      ) : null}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
