import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Poppler on Windows does not reliably read a PDF from stdin, so every call
// writes a real input file. Text output is written to a real file and decoded
// explicitly as UTF-8 with `-enc UTF-8`, so Chinese survives on every platform.
function withPdfFile<T>(bytes: Uint8Array, run: (input: string, output: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "xprint-poppler-"));
  try {
    const input = join(directory, "input.pdf");
    const output = join(directory, "output.txt");
    writeFileSync(input, bytes);
    return run(input, output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkedResult(tool: string, result: ReturnType<typeof Bun.spawnSync>) {
  if (result.exitCode !== 0) {
    throw new Error(`${tool} 退出码 ${result.exitCode}：${result.stderr.toString()}`);
  }
  return result;
}

export function pdfInfo(bytes: Uint8Array) {
  return withPdfFile(bytes, input => {
    const result = checkedResult("pdfinfo", Bun.spawnSync(["pdfinfo", input], { stdout: "pipe", stderr: "pipe" }));
    return result.stdout.toString("utf8");
  });
}

export function pdfText(bytes: Uint8Array, firstPage?: number, lastPage?: number) {
  return withPdfFile(bytes, (input, output) => {
    const args = ["-layout", "-enc", "UTF-8"];
    if (firstPage !== undefined && lastPage !== undefined) args.push("-f", String(firstPage), "-l", String(lastPage));
    args.push(input, output);
    checkedResult("pdftotext", Bun.spawnSync(["pdftotext", ...args], { stdout: "pipe", stderr: "pipe" }));
    return readFileSync(output, "utf8");
  });
}
