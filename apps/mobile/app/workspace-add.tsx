import { View } from "react-native";
import { ConnectForm } from "@/components/connect-form";
import { Screen } from "@/components/screen";

/** Another kernel on this phone, by its address or an invitation link. */
export default function ConnectKernel() {
  return (
    <Screen back="close" title="Connect a kernel">
      <View className="px-5 pt-4">
        <ConnectForm autoFocus />
      </View>
    </Screen>
  );
}
