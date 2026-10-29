import { View } from "react-native";
import { ConnectForm } from "@/components/connect-form";
import { Screen } from "@/components/screen";

/** Another workspace on this phone: on a kernel already kept, or on another. */
export default function AddWorkspace() {
  return (
    <Screen back="close" title="Add workspace">
      <View className="px-5 pt-4">
        <ConnectForm autoFocus />
      </View>
    </Screen>
  );
}
