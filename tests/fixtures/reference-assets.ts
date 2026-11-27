// Asset sidecar for the upstream Hydro template. It mirrors upstream
// packages/server/client/assets.js, reading the same six files from the pinned
// npm packages that this project's bun.lock already installs.
import mono from "dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf" with { type: "file" };
import monoBold from "dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf" with { type: "file" };
import monoOblique from "dejavu-fonts-ttf/ttf/DejaVuSansMono-Oblique.ttf" with { type: "file" };
import monoBoldOblique from "dejavu-fonts-ttf/ttf/DejaVuSansMono-BoldOblique.ttf" with { type: "file" };
import noto from "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf" with { type: "file" };
import wasm from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm" with { type: "file" };

async function bytes(url: string) {
  return new Uint8Array(await Bun.file(url).arrayBuffer());
}

export const DejaVuSansMono = await bytes(mono);
export const DejaVuSansMonoBold = await bytes(monoBold);
export const DejaVuSansMonoOblique = await bytes(monoOblique);
export const DejaVuSansMonoBoldOblique = await bytes(monoBoldOblique);
export const NotoSansSC = await bytes(noto);
export const wasmBinary = await bytes(wasm);
