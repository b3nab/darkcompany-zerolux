// Before anything else: `crypto.getRandomValues` for message IDs, WebRTC for LiveKit.
import "react-native-get-random-values";
import { registerGlobals } from "@livekit/react-native";

registerGlobals();

import "expo-router/entry";
