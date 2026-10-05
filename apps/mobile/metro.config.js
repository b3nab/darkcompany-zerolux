const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// Workspace packages bring their own copy of React: the app must run on a single one.
const single = ["react", "react-native"];
config.resolver.resolveRequest = (context, name, platform) =>
  context.resolveRequest(
    single.some((module) => name === module || name.startsWith(`${module}/`))
      ? { ...context, originModulePath: path.join(__dirname, "index.ts") }
      : context,
    name,
    platform,
  );

// Outermost on purpose: Uniwind compiles global.css and generates the className types.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
