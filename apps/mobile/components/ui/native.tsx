import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { KeyboardGestureArea } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

/**
 * Third-party components with `className` (and `contentContainerClassName`): Uniwind styles
 * React Native's own components out of the box, these need the wrapper.
 */
export const SafeArea = withUniwind(SafeAreaView);
export const GestureArea = withUniwind(KeyboardGestureArea);
export const ChatList = withUniwind(KeyboardAwareLegendList);
