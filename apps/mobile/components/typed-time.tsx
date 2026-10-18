import { TextInput, View } from "react-native";
import { Text } from "@/components/ui/text";

/** A time of day, as the schedule form asks it; for every hour, only the minute counts. */
export interface TimeFieldProps {
  hour: number;
  minute: number;
  minuteOnly: boolean;
  change: (hour: number, minute: number) => void;
}

/** The hour and minutes, typed. */
export function TypedTime({
  hour,
  minute,
  minuteOnly,
  change,
}: TimeFieldProps) {
  const field = (value: number, max: number, set: (value: number) => void) => (
    <TextInput
      value={String(value).padStart(2, "0")}
      onChangeText={(text) => {
        const typed = Number(text.replace(/\D/g, "").slice(-2));
        if (typed <= max) set(typed);
      }}
      keyboardType="number-pad"
      selectTextOnFocus
      className="w-12 rounded-md border border-input bg-card px-2 py-2 text-center font-mono text-[15px] text-foreground"
    />
  );
  return (
    <View className="flex-row items-center gap-1">
      {minuteOnly ? null : (
        <>
          {field(hour, 23, (value) => change(value, minute))}
          <Text className="font-mono text-[15px]">:</Text>
        </>
      )}
      {field(minute, 59, (value) => change(hour, value))}
    </View>
  );
}
