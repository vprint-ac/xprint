declare module "*.ttf" {
  const path: string;
  export default path;
}
declare module "*.wasm" {
  const path: string;
  export default path;
}
// The upstream ESM entry and shim share a declaration file named without .mjs.
declare module "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
  export * from "@myriaddreamin/typst-ts-web-compiler";
}
declare module "@myriaddreamin/typst-ts-web-compiler/pkg/wasm-pack-shim.mjs" {
  export * from "@myriaddreamin/typst-ts-web-compiler";
}
