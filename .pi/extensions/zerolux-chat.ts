import chatExtension from "../../harnesses/pi/src/chat-extension.ts";

// This project's preference, not a policy for other people's pi sessions.
export default (pi: Parameters<typeof chatExtension>[0]) =>
  chatExtension(pi, { autoCompactFrom: 0.96 });
