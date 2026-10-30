import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { NewWorkspaceForm } from "@/components/new-workspace";
import { Screen } from "@/components/screen";
import { useKernel } from "../src/kernel";

/** A new workspace on one of the phone's kernels: the one named, else the open one. */
export default function NewWorkspace() {
  const params = useLocalSearchParams<{ kernel?: string }>();
  const { here } = useKernel();
  const kernel = params.kernel ?? here;
  if (!kernel) return null;
  return (
    <Screen back="close" title="New workspace" subtitle={new URL(kernel).host}>
      <View className="px-5 pt-4">
        <NewWorkspaceForm kernel={kernel} autoFocus />
      </View>
    </Screen>
  );
}
