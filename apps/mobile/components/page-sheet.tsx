import type { ReactNode } from "react";
import { Modal, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * A sheet over the screen: iOS's page sheet; on Android the whole screen, its top kept clear
 * of the status bar it is drawn under.
 */
export function PageSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { top } = useSafeAreaInsets();
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        className="flex-1 bg-background"
        style={Platform.OS === "android" ? { paddingTop: top } : undefined}
      >
        {children}
      </View>
    </Modal>
  );
}
