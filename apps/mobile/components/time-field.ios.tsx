import { DatePicker, Host } from "@expo/ui/swift-ui";
import { TypedTime } from "@/components/typed-time";
import type { TimeFieldProps } from "@/components/typed-time";
import { useTheme } from "../src/theme";

/** iOS's own time picker; for every hour, the minute typed, as elsewhere. */
export function TimeField(props: TimeFieldProps) {
  const { resolved } = useTheme();
  if (props.minuteOnly) return <TypedTime {...props} />;
  const selection = new Date();
  selection.setHours(props.hour, props.minute, 0, 0);
  return (
    <Host matchContents colorScheme={resolved}>
      <DatePicker
        selection={selection}
        displayedComponents={["hourAndMinute"]}
        onDateChange={(date) =>
          props.change(date.getHours(), date.getMinutes())
        }
      />
    </Host>
  );
}
