import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutPrintout, languageForFilename, type LayoutInput } from "../src/layout.ts";

// `bun test` forces UTC, while the Hydro reference PDF was rendered in
// Asia/Shanghai. Pin the zone so the header time matches the reference.
process.env.TZ = "Asia/Shanghai";

const fixedTime = new Date(2026, 10, 27, 14, 32, 8);
const referenceTimestamp = 1795761128000;
const fixtures = new URL("./fixtures/", import.meta.url);

function pdfText(bytes: Uint8Array, firstPage?: number, lastPage?: number) {
  const args = ["pdftotext", "-layout"];
  if (firstPage) args.push("-f", String(firstPage), "-l", String(lastPage));
  return Bun.spawnSync([...args, "-", "-"], { stdin: Buffer.from(bytes) }).stdout.toString();
}

function pdfInfo(bytes: Uint8Array) {
  return Bun.spawnSync(["pdfinfo", "-"], { stdin: Buffer.from(bytes) }).stdout.toString();
}

async function fixture(name: string) {
  return Bun.file(new URL(name, fixtures)).bytes();
}

function rasterHashes(pdf: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "xprint-raster-"));
  try {
    const input = join(directory, "input.pdf");
    writeFileSync(input, pdf);
    const result = Bun.spawnSync(["pdftoppm", "-r", "96", "-png", input, join(directory, "page")]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return readdirSync(directory).filter(name => name.endsWith(".png")).sort()
      .map(name => createHash("sha256").update(readFileSync(join(directory, name))).digest("hex"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("languageForFilename", () => {
  test("maps known extensions and falls back to plain text", () => {
    expect(languageForFilename("A.cpp")).toBe("cpp");
    expect(languageForFilename("main.py")).toBe("python");
    expect(languageForFilename("notes.unknownext")).toBe("");
    expect(languageForFilename("noextension")).toBe("");
  });
});

describe("layoutPrintout", () => {
  for (const [sample, reference, color] of [
    ["layout.cpp", "hydro-layout-bw.pdf", false],
    ["long-lines.cpp", "hydro-long-lines-color.pdf", true],
  ] as const) {
    test(`${sample} matches the upstream Hydro reference page for page`, async () => {
      const { pdf } = await layoutPrintout({
        filename: sample,
        text: new TextDecoder().decode(await fixture(sample)),
        printedAt: new Date(referenceTimestamp),
        color,
        team: "校队",
        seat: "007",
      });
      expect(rasterHashes(pdf)).toEqual(rasterHashes(await fixture(reference)));
    });
  }

  test("returns a reliable page count when asked", async () => {
    const text = Array.from({ length: 420 }, (_, index) => `int value_${index} = ${index};\n`).join("");
    for (const color of [false, true]) {
      const { pdf, pageCount } = await layoutPrintout(
        { filename: "count.cpp", text, printedAt: fixedTime, color },
      );
      const pages = Number(/Pages:\s+(\d+)/.exec(pdfInfo(pdf))?.[1]);
      expect(pageCount).toBe(pages);
    }
  });

  test("a small C++ file produces a PDF with filename, one print time and the last line", async () => {
    const input: LayoutInput = {
      filename: "A.cpp",
      text: '#include <bits/stdc++.h>\n// 中文注释\nint main() { return 0; }\n// LAST LINE\n',
      printedAt: fixedTime,
      color: false,
      team: "校队",
      seat: "007",
    };
    const { pdf } = await layoutPrintout(input);
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain("A.cpp");
    expect(text).toContain("2026/11/27 14:32:08");
    expect(text).toContain("校队");
    expect(text).toContain("007");
    expect(text).toContain("LAST LINE");
    expect(text).toContain("中文注释");
  });

  test("a file longer than five pages keeps its final line on the last page", async () => {
    const lines = Array.from({ length: 420 }, (_, index) => `  int value_${index} = ${index}; // 行 ${index}`);
    const input: LayoutInput = {
      filename: "long.cpp",
      text: lines.join("\n") + "\n// FINAL\n",
      printedAt: fixedTime,
      color: false,
    };
    const { pdf } = await layoutPrintout(input);
    const info = pdfInfo(pdf);
    const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
    expect(pages).toBeGreaterThan(5);
    const lastPage = pdfText(pdf, pages, pages);
    expect(lastPage).toContain("FINAL");
    expect(lastPage).toContain(`Page ${pages} of ${pages}`);
  });

  test("an unknown extension renders as plain text with no syntax highlighting", async () => {
    const { pdf } = await layoutPrintout({
      filename: "solution.unknownext",
      text: "int main() { return 0; } // 关键字不应高亮\n",
      printedAt: fixedTime,
      color: false,
    });
    expect(pdfText(pdf)).toContain("int main()");
    const { pdf: highlighted } = await layoutPrintout({
      filename: "solution.cpp",
      text: "int main() { return 0; } // 关键字不应高亮\n",
      printedAt: fixedTime,
      color: false,
    });
    expect(rasterHashes(pdf)).not.toEqual(rasterHashes(highlighted));
  });

  test("Chinese text in comments, long lines and indentation survives layout", async () => {
    const { pdf } = await layoutPrintout({
      filename: "zh.cpp",
      text: 'int main() {\n    // 中文注释：跨页代码与缩进\n    std::cout << "训练记录" << \'\\n\'; // 末尾\n}\n',
      printedAt: fixedTime,
      color: false,
    });
    const text = pdfText(pdf);
    expect(text).toContain("中文注释：跨页代码与缩进");
    expect(text).toContain("训练记录");
    expect(text).toContain("末尾");
  });
});
