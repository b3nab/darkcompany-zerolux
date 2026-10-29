import { View } from "react-native";
import { Wordmark } from "@/components/brand";
import { ConnectForm } from "@/components/connect-form";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useKernel } from "../src/kernel";

/** The first run: where the kernel is, by its address or an invitation link. */
export default function Connect() {
  const kernel = useKernel();
  if (kernel.url === undefined)
    return (
      <SafeArea className="flex-1 justify-center bg-background p-6">
        <Text>Opening the saved workspaces…</Text>
      </SafeArea>
    );
  return (
    <SafeArea className="flex-1 justify-center gap-4 bg-background p-6">
      <Wordmark height={22} />
      <Text className="text-[34px] font-light tracking-tight">
        Connect to ZeroLux
      </Text>
      {kernel.error ? (
        <Text className="text-sm text-destructive">{kernel.error}</Text>
      ) : null}
      <View>
        <ConnectForm />
      </View>
    </SafeArea>
  );
}
