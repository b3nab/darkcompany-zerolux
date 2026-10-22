import { SearchIcon, XIcon } from "lucide-react-native";
import { Pressable, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { cn } from "@/lib/utils";

/** A search box: what it looks for as its placeholder, and a way to clear it. */
export function SearchField({
  value,
  onChange,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 rounded-md bg-muted px-2.5",
        className,
      )}
    >
      <SearchIcon color={faint} size={16} strokeWidth={1.75} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor={faint}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={label}
        className="flex-1 py-2 font-sans text-[15px] text-foreground"
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange("")}
          hitSlop={8}
        >
          <XIcon color={faint} size={16} strokeWidth={1.75} />
        </Pressable>
      ) : null}
    </View>
  );
}
