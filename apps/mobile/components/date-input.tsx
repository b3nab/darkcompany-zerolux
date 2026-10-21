import {
  DatePickerDialog,
  Host as ComposeHost,
} from "@expo/ui/jetpack-compose";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle } from "@expo/ui/swift-ui/modifiers";
import { CalendarIcon, XIcon } from "lucide-react-native";
import { useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import type { DateInputProps } from "@zerolux/ui";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useTheme } from "../src/theme";

/** A day as `YYYY-MM-DD`; Android's calendar gives it in UTC, iOS's in the local day. */
const day = (date: Date, utc: boolean) =>
  [
    utc ? date.getUTCFullYear() : date.getFullYear(),
    (utc ? date.getUTCMonth() : date.getMonth()) + 1,
    utc ? date.getUTCDate() : date.getDate(),
  ]
    .map((n, i) => String(n).padStart(i ? 2 : 4, "0"))
    .join("-");

const local = (value: string) => {
  const [year, month, date] = value.split("-").map(Number);
  return new Date(year!, month! - 1, date);
};

/**
 * A day picked with the system's calendar: iOS's in a sheet, Android's in its dialog. Picking
 * a day closes it; the cross takes the day away.
 */
export function DateInput({
  value,
  onChange,
  label,
  placeholder = "No date",
  disabled,
}: DateInputProps) {
  const { resolved } = useTheme();
  const [faint, muted] = useCSSVariable([
    "--color-faint",
    "--color-muted-foreground",
  ]).map(String);
  const [open, setOpen] = useState(false);
  const pick = (date: string) => {
    setOpen(false);
    onChange(date);
  };
  return (
    <View className="gap-1.5">
      {label ? <Text className="text-sm font-medium">{label}</Text> : null}
      <View
        className={cn(
          "h-10 flex-row items-center rounded-md border border-input bg-background",
          disabled && "opacity-50",
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ?? placeholder}
          disabled={disabled}
          onPress={() => setOpen(true)}
          className="h-full flex-1 flex-row items-center gap-2 px-3"
        >
          <CalendarIcon color={muted} size={16} strokeWidth={1.5} />
          <Text className={cn("text-[15px]", !value && "text-faint")}>
            {value
              ? local(value).toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : placeholder}
          </Text>
        </Pressable>
        {value && !disabled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear"
            onPress={() => onChange(null)}
            hitSlop={8}
            className="h-full justify-center px-3"
          >
            <XIcon color={faint} size={16} strokeWidth={1.5} />
          </Pressable>
        ) : null}
      </View>
      {open && Platform.OS === "android" ? (
        <ComposeHost matchContents>
          <DatePickerDialog
            initialDate={value}
            onDateSelected={(date) => pick(day(date, true))}
            onDismissRequest={() => setOpen(false)}
          />
        </ComposeHost>
      ) : null}
      {Platform.OS === "ios" ? (
        <Modal
          visible={open}
          animationType="slide"
          presentationStyle="formSheet"
          onRequestClose={() => setOpen(false)}
        >
          <View className="flex-1 gap-2 bg-background px-4">
            <View className="flex-row items-center justify-between py-3">
              <Text className="text-[17px] font-semibold">
                {label ?? "Date"}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                hitSlop={12}
              >
                <Text className="text-base font-medium text-human-foreground">
                  Cancel
                </Text>
              </Pressable>
            </View>
            <Host matchContents colorScheme={resolved}>
              <DatePicker
                selection={value ? local(value) : new Date()}
                displayedComponents={["date"]}
                modifiers={[datePickerStyle("graphical")]}
                onDateChange={(date) => pick(day(date, false))}
              />
            </Host>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
