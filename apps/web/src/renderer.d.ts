// The renderer bundles (`bun run renderer`), imported as files: their address, not their code.
declare module "*/generated/renderer/code.js" {
  const url: string;
  export default url;
}
declare module "*/generated/renderer/mermaid.js" {
  const url: string;
  export default url;
}
