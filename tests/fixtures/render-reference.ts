// Regenerates the checked-in upstream Hydro goldens from the pinned template.
//
//   bun tests/fixtures/render-reference.ts --upstream ../hydro-reference --out evidence
//
// The upstream packages/server/client/typst.ts is bundled unmodified. Its
// relative ./assets import is redirected to reference-assets.ts, which reads
// the fonts and WASM compiler from this project's locked npm dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const upstreamCommit = "b4faf1f11adb9b1f92db6fbfc55d2de833264a3f";
const fixtures = [
  { source: "layout.cpp", pdf: "hydro-layout-bw.pdf", color: false },
  { source: "long-lines.cpp", pdf: "hydro-long-lines-color.pdf", color: true },
];
const fixedTime = 1795761128000;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    upstream: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.upstream || !values.out) {
  throw new Error("用法：bun tests/fixtures/render-reference.ts --upstream <hydro-dev/xcpc-tools 检出目录> --out <输出目录>");
}

const upstream = resolve(values.upstream);
const template = join(upstream, "packages/server/client/typst.ts");
if (!existsSync(template)) throw new Error(`在 ${upstream} 下找不到 ${template}。`);
const git = (...args: string[]) => execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
if (commit !== upstreamCommit) throw new Error(`上游 HEAD 为 ${commit}，需要 ${upstreamCommit}。`);
if (git("status", "--porcelain", "--", "packages/server/client/typst.ts")) {
  throw new Error("上游 typst.ts 有未提交的修改，基准需要来自原始提交。");
}

const here = fileURLToPath(new URL(".", import.meta.url));
const assets = join(here, "reference-assets.ts");
const compilerModule = fileURLToPath(await import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs"));
const directory = realpathSync(mkdtempSync(join(tmpdir(), "xprint-reference-")));
const built = await Bun.build({
  entrypoints: [template],
  target: "bun",
  format: "esm",
  outdir: directory,
  plugins: [{
    name: "xprint-reference-assets",
    setup(build) {
      build.onResolve({ filter: /^\.\/assets(\.js)?$/ }, (args) => {
        if (args.importer !== template) return undefined;
        return { path: args.path, namespace: "xprint-reference-assets" };
      });
      // The template imports the WASM compiler dynamically, so rewrite it to an
      // absolute path that resolves from the temporary bundle location.
      build.onResolve({ filter: /typst-ts-web-compiler\/pkg\/typst_ts_web_compiler\.mjs$/ }, () => ({ path: compilerModule }));
      build.onLoad({ filter: /.*/, namespace: "xprint-reference-assets" }, () => ({
        contents: `export { DejaVuSansMono, DejaVuSansMonoBold, DejaVuSansMonoOblique, DejaVuSansMonoBoldOblique, NotoSansSC, wasmBinary } from ${JSON.stringify(assets)};`,
        loader: "ts",
      }));
    },
  }],
  external: [assets],
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
const bundle = built.outputs.find((output) => output.kind === "entry-point")?.path;
if (!bundle) throw new Error("没有生成模板 bundle。");

try {
  const { createTypstCompiler, generateTypst } = await import(bundle);
  const compiler = await createTypstCompiler();
  mkdirSync(resolve(values.out), { recursive: true });
  for (const fixture of fixtures) {
    const template = generateTypst("校队", "007", "source", fixture.source, "cpp", fixedTime, fixture.color);
    compiler.addSource("/main.typst", template.replace("By Hydro/XCPC-TOOLS | Page #context", "Page #context"));
    compiler.addSource("/source", await Bun.file(join(here, fixture.source)).text());
    const pdf = await compiler.compile({ format: "pdf", mainFilePath: "/main.typst" });
    const output = join(resolve(values.out), fixture.pdf);
    await Bun.write(output, pdf);
    console.log(`${output}  ${pdf.byteLength} bytes`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
