import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bun = process.execPath;
const testsDir = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
let binary: string;
let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "xprint-pty-"));
  binary = join(work, "xprint");
  const build = spawnSync(bun, ["build", "src/index.ts", "--compile", "--outfile", binary], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
});

afterAll(async () => {
  await Bun.$`rm -rf ${work}`;
});

async function fakeLp(response: string, capturePath: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-pty-bin-"));
  const lp = join(dir, "lp");
  await writeFile(lp, `#!/bin/sh\ncat > "${capturePath}"\necho "${response}"\n`);
  await chmod(lp, 0o755);
  const lpstat = join(dir, "lpstat");
  await writeFile(lpstat, `#!/bin/sh
if [ "$1" = "-d" ]; then echo "系统默认目的位置：HP_LaserJet"; fi
if [ "$1" = "-e" ]; then echo "HP_LaserJet"; fi
`);
  await chmod(lpstat, 0o755);
  return dir;
}

/**
 * Runs the compiled CLI under a real PTY and feeds `keys` once the confirmation
 * prompt is visible. `python3 pty.openpty` works on both BSD and Linux, and the
 * window size is set because Clack reads `columns` to lay out the prompt.
 * `CI` is cleared so the CLI takes its interactive path.
 */
function invokePty(args: string[], cwd: string, env: Record<string, string>, keys: string[], beforeKeys?: string) {
  const driverArgs = [join(testsDir, "pty-driver.py"), binary, JSON.stringify(args), cwd, env.PATH, JSON.stringify(keys)];
  if (beforeKeys) driverArgs.push(beforeKeys);
  const child = spawn("python3", driverArgs, {
    cwd,
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const result = new Promise<{ code: number | null; output: string }>(resolve => {
    child.once("close", code => resolve({ code, output }));
    child.once("error", error => resolve({ code: -1, output: output + String(error) }));
  });
  return result.then(({ output: text }) => {
    const marker = /\nXPRINT_EXIT=(-?\d+)\s*$/.exec(text);
    if (!marker) throw new Error("PTY driver did not report a child exit code: " + text);
    return { status: Number(marker[1]), output: text.slice(0, marker.index) };
  });
}

async function fixture(content = "int main(){}\n") {
  const dir = await mkdtemp(join(tmpdir(), "xprint-pty-contest-"));
  const capture = join(dir, "captured.pdf");
  const binDir = await fakeLp("request id is HP_LaserJet-42 (1 file(s))", capture);
  const source = join(dir, "A.cpp");
  await writeFile(source, content);
  return { dir, capture, source, env: { PATH: `${binDir}:${process.env.PATH}` } };
}

describe("interactive confirmation over a real PTY", () => {
  test.each(["\r", "y", "Y"])("confirmation %j submits one job with its id", async key => {
    const { dir, capture, env } = await fixture();
    const result = await invokePty(["A.cpp"], dir, env, [key]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("确认打印？");
    expect(result.output).toContain("HP_LaserJet-42");
    expect(await Bun.file(capture).exists()).toBe(true);
  });

  test.each(["n", "N"])("cancel key %j produces zero jobs", async key => {
    const { dir, capture, env } = await fixture();
    const result = await invokePty(["A.cpp"], dir, env, [key]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("已取消");
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("Ctrl+C exits with code 130 and zero jobs", async () => {
    const { dir, capture, env } = await fixture();
    const result = await invokePty(["A.cpp"], dir, env, ["\x03"]);
    expect(result.status).toBe(130);
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("a save while the prompt waits does not change the printed snapshot", async () => {
    const { dir, capture, source, env } = await fixture("int original_line;\n");
    const result = await invokePty(["A.cpp"], dir, env, ["\r"], `printf 'int edited_after_prompt;\\n' > "${source}"`);
    expect(result.status).toBe(0);
    const pdf = new Uint8Array(await readFile(capture));
    const text = spawnSync("pdftotext", ["-", "-"], { input: Buffer.from(pdf), encoding: "utf8" }).stdout;
    expect(text).toContain("original_line");
    expect(text).not.toContain("edited_after_prompt");
  });
});
