import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bun = process.execPath;
const root = new URL("..", import.meta.url).pathname;
let binary: string;
let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "xprint-cli-"));
  binary = join(work, "xprint");
  const build = spawnSync(bun, ["build", "src/index.ts", "--compile", "--outfile", binary], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
});

afterAll(async () => {
  await Bun.$`rm -rf ${work}`;
});

async function fakeLp(response: string, capturePath: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-bin-"));
  const lp = join(dir, "lp");
  await writeFile(lp, `#!/bin/sh\ncat > "${capturePath}"\necho "${response}"\n`);
  await chmod(lp, 0o755);
  const lpstat = join(dir, "lpstat");
  await writeFile(lpstat, `#!/bin/sh
if [ "$1" = "-d" ]; then echo "系统默认目的位置：Practice_Printer"; fi
if [ "$1" = "-e" ]; then echo "Practice_Printer"; echo "PDF"; fi
`);
  await chmod(lpstat, 0o755);
  return dir;
}

async function invoke(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(binary, args, { cwd, env: { ...process.env, ...env } });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdin.end();
  const status = await new Promise<number | null>(resolve => child.once("close", resolve));
  return { status, output };
}

describe("compiled xprint CLI", () => {
  test("shows the Chinese help when run without arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-help-"));
    const result = await invoke([], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("用法");
    expect(result.output).toContain("将一份 UTF-8 源码排版后提交到本机打印机");
    expect(result.output).toMatch(/-y, --yes/);
  });

  test("rejects -y without a file name in Chinese", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-no-file-"));
    const result = await invoke(["-y"], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("请指定要打印的文件");
    expect(result.output).not.toContain("用法");
  });

  test("prints exactly one job to the default queue with -y and reports the job id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is HP_DeskJet-42 (1 file(s))", capture);
    const source = join(dir, "A.cpp");
    await writeFile(source, "#include <cstdio>\n// 中文注释\nint main() { puts(\"hi\"); }\n");
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Practice_Printer");
    expect(result.output).toContain("HP_DeskJet-42");
    expect(result.output).toContain("页");
    const pdf = new Uint8Array(await Bun.file(capture).arrayBuffer());
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
    const text = spawnSync("pdftotext", ["-", "-"], { input: Buffer.from(pdf), encoding: "utf8" }).stdout;
    expect(text).toContain("A.cpp");
    expect(text).toContain("中文注释");
  });

  test("refuses to print without -y in a non-interactive environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is never", capture);
    const source = join(dir, "A.cpp");
    await writeFile(source, "int main(){}\n");
    const result = await invoke(["A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}`, CI: "1" });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/-y|--yes/);
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("A.cpp --yes keeps the summary and submits one job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is HP_DeskJet-43 (1 file(s))", capture);
    const source = join(dir, "A.cpp");
    await writeFile(source, "int main(){}\n");
    const result = await invoke(["A.cpp", "--yes"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(0);
    expect(result.output).toContain("文件名　　A.cpp");
    expect(result.output).toContain("HP_DeskJet-43");
    const pdf = new Uint8Array(await Bun.file(capture).arrayBuffer());
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
  });

  test("rejects multiple files with a clear message and zero jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is never", capture);
    await writeFile(join(dir, "A.cpp"), "int main(){}\n");
    await writeFile(join(dir, "B.cpp"), "int main(){}\n");
    const result = await invoke(["-y", "A.cpp", "B.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("一次只能打印一个文件");
    expect(result.output).toContain("2 个");
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("accepts exactly 16,384 bytes and submits one job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is HP_DeskJet-44 (1 file(s))", capture);
    const source = join(dir, "edge.cpp");
    const bytes = new Uint8Array(16_384).fill(0x61);
    bytes.set(new TextEncoder().encode("// 边界\n"));
    await writeFile(source, bytes);
    const result = await invoke(["-y", "edge.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(0);
    expect(result.output).toContain("16,384 字节");
    expect(await Bun.file(capture).exists()).toBe(true);
  });

  test("rejects a 16,385-byte file before contacting the print backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is never", capture);
    const source = join(dir, "big.cpp");
    await writeFile(source, new Uint8Array(16_385).fill(0x61));
    const result = await invoke(["-y", "big.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("16,385");
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("reports a configured queue that does not exist and produces zero jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeLp("request id is never", capture);
    const source = join(dir, "A.cpp");
    await writeFile(source, "int main(){}\n");
    await writeFile(join(dir, ".xprint.yaml"), "printer: Missing_Queue\n");
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing_Queue");
    expect(await Bun.file(capture).exists()).toBe(false);
  });
});
