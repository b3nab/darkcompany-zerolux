/// <reference types="node" />
import type { ConfigContext, ExpoConfig } from "expo/config";
import { join } from "node:path";
import { baseVersion, buildInfo } from "../../scripts/build-info.ts";

export default ({ config }: ConfigContext): ExpoConfig => {
  const build = buildInfo(join(__dirname, "../.."));
  // UTC seconds since 2020: increasing across every channel, within Android's integer limit.
  const number = Math.floor(
    (Date.parse(build.built_at) - Date.UTC(2020, 0, 1)) / 1000,
  );
  return {
    ...config,
    name: config.name || "ZeroLux",
    slug: config.slug || "zerolux",
    version: baseVersion(build.version),
    ios: { ...config.ios, buildNumber: String(number) },
    android: { ...config.android, versionCode: number },
    extra: { ...config.extra, build },
  };
};
