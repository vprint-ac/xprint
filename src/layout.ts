import wasmUrl from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm" with { type: "file" };
import monoUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf" with { type: "file" };
import monoBoldUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf" with { type: "file" };
import monoObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono-Oblique.ttf" with { type: "file" };
import monoBoldObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono-BoldOblique.ttf" with { type: "file" };
import notoUrl from "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf" with { type: "file" };
import { BWTmTheme, generateTypst } from "./hydro-template.ts";

export interface LayoutInput {
  filename: string;
  text: string;
  printedAt: Date;
  color: boolean;
  team?: string;
  seat?: string;
}

export interface LayoutResult {
  pdf: Uint8Array;
  pageCount: number;
}

const languages: Record<string, string> = {
  c: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  py: "python", java: "java", kt: "kotlin", kts: "kotlin",
  rs: "rust", go: "go", js: "javascript",
};

export function languageForFilename(filename: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1].toLowerCase();
  return extension && languages[extension] ? languages[extension] : "";
}

async function asset(url: string) {
  return new Uint8Array(await Bun.file(url).arrayBuffer());
}

let compilerPromise: Promise<import("@myriaddreamin/typst-ts-web-compiler/pkg/wasm-pack-shim.mjs").TypstCompiler> | undefined;

function compiler() {
  compilerPromise ??= (async () => {
    const mod = await import("@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs");
    mod.initSync({ module: await asset(wasmUrl) });
    const builder = new mod.TypstCompilerBuilder();
    for (const url of [monoUrl, monoBoldUrl, monoObliqueUrl, monoBoldObliqueUrl, notoUrl]) {
      await builder.add_raw_font(await asset(url));
    }
    const built = await builder.build();
    built.add_source("/XCPCTOOLS/BW.tmtheme", BWTmTheme);
    return built;
  })();
  return compilerPromise;
}

export async function layoutPrintout(input: LayoutInput): Promise<LayoutResult> {
  const instance = await compiler();
  const lang = languageForFilename(input.filename);
  const source = generateTypst(
    input.team ?? "",
    input.seat ?? "",
    "source",
    input.filename,
    lang,
    input.printedAt.getTime(),
    input.color,
  );
  instance.reset();
  instance.add_source("/main.typst", source);
  instance.add_source("/source", input.text);
  const output = instance.compile("/main.typst", [], "pdf", 0);
  if (!(output instanceof Uint8Array)) throw new Error("排版失败，未能生成 PDF。");
  const counts = JSON.parse(instance.query("/main.typst", [], "<xprint-page-count>", "value")) as number[];
  if (counts.length !== 1 || !Number.isSafeInteger(counts[0]) || counts[0] < 1) {
    throw new Error("排版失败，无法读取打印件的总页数。");
  }
  return { pdf: output, pageCount: counts[0] };
}
