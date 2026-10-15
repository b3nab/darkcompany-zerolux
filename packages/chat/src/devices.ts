const systems: [string, string][] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Macintosh", "Mac"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
];
// Order matters: Edge and Chrome also name Safari, Chrome names Safari too.
const browsers: [string, string][] = [
  ["Edg/", "Edge"],
  ["Firefox/", "Firefox"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];

/** A signed-in device as a person reads it, from its user agent: "Chrome on Mac". */
export function deviceName(userAgent?: string | null): string {
  const agent = userAgent ?? "";
  // The phone app's own requests name no browser: iOS sends "ZeroLux/1 CFNetwork/… Darwin/…",
  // Android sends okhttp.
  if (agent.includes("CFNetwork")) return "ZeroLux app on iOS";
  if (agent.includes("okhttp")) return "ZeroLux app on Android";
  const system = systems.find(([token]) => agent.includes(token))?.[1];
  const browser = browsers.find(([token]) => agent.includes(token))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return system ?? browser ?? "Unknown device";
}
