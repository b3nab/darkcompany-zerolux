import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

/** A file on this phone as the `File` the kernel's storage takes. */
export async function asFile(uri: string, name: string, type?: string) {
  const blob = await (await fetch(uri)).blob();
  return new File([blob], name, { type: type ?? blob.type });
}

/** Records from the microphone: one recording at a time, kept until stopped or dropped. */
export function useVoice() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const release = () => setAudioModeAsync({ allowsRecording: false });
  return {
    recording: state.isRecording,
    seconds: Math.floor(state.durationMillis / 1000),
    async start() {
      if (!(await requestRecordingPermissionsAsync()).granted)
        throw new Error("Allow the microphone for ZeroLux in Settings.");
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
    },
    /** Ends the recording and gives it as a file with this name. */
    async stop(name: string) {
      await recorder.stop();
      await release();
      return recorder.uri ? asFile(recorder.uri, name) : undefined;
    },
    /** Drops the recording. */
    async cancel() {
      if (state.isRecording) await recorder.stop();
      await release();
    },
  };
}
