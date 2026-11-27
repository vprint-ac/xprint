import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const bun = process.execPath;
const root = new URL("..", import.meta.url).pathname;
let binary: string;
let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "xprint-config-cli-"));
  binary = join(work, "xprint");
  const build = spawnSync(bun, ["build", "src/index.ts", "--compile", "--outfile", binary], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
});

afterAll(async () => {
  await Bun.$`rm -rf ${work}`;
});

const knownQueues = ["Practice_Printer", "HP_LaserJet", "HP_ColorJet"];

async function fakeBackend(capturePath: string, argsPath: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-config-bin-"));
  const lp = join(dir, "lp");
  await writeFile(lp, `#!/bin/sh\necho "$@" > "${argsPath}"\ncat > "${capturePath}"\necho "request id is HP_LaserJet-42 (1 file(s))"\n`);
  await chmod(lp, 0o755);
  const lpstat = join(dir, "lpstat");
  await writeFile(lpstat, `#!/bin/sh
if [ "$1" = "-d" ]; then echo "系统默认目的位置：Practice_Printer"; fi
if [ "$1" = "-e" ]; then
${knownQueues.map(queue => `  echo "${queue}"`).join("\n")}
  echo "PDF"
fi
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

// The user configuration lives at the platform convention, so tests must write
// there instead of assuming a Linux-style path.
async function userConfigPath(home: string) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "xprint", "config.yaml");
  if (process.platform === "win32") return join(home, "AppData", "Local", "xprint", "config.yaml");
  return join(home, ".config", "xprint", "config.yaml");
}

async function contestDir() {
  const dir = await mkdtemp(join(tmpdir(), "xprint-contest-"));
  const source = join(dir, "A.cpp");
  await writeFile(source, "int main(){}\n");
  return dir;
}

describe("xprint configuration", () => {
  test("with no configuration the system default queue is used in monochrome", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}`, HOME: home });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Practice_Printer");
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("-d Practice_Printer");
    expect(lpArgs).toContain("ColorModel=Gray");
  });

  test("a missing XPRINT_CONFIG file is reported with its resolved path and no job is submitted", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}`, XPRINT_CONFIG: "missing.yaml" });
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, "missing.yaml"));
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("each layer only overrides the fields it sets and the job uses the merged queue and color", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    const userConfig = await userConfigPath(home);
    await mkdir(dirname(userConfig), { recursive: true });
    await writeFile(userConfig, "printer: HP_LaserJet\ncolor: monochrome\nteam: 校队\n");
    await writeFile(join(dir, ".xprint.yaml"), "color: color\ncontest: 周六训练\nlocation: \"007\"\n");
    await writeFile(join(dir, "mono.yaml"), "printer: HP_ColorJet\n");
    const result = await invoke(["-y", "A.cpp"], dir, {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      XPRINT_CONFIG: "mono.yaml",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("HP_ColorJet");
    expect(result.output).toContain("周六训练");
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("-d HP_ColorJet");
    expect(lpArgs).toContain("ColorModel=RGB");
    const pdf = new Uint8Array(await Bun.file(capture).arrayBuffer());
    const text = spawnSync("pdftotext", ["-", "-"], { input: Buffer.from(pdf), encoding: "utf8" }).stdout;
    expect(text).toContain("校队");
    expect(text).toContain("007");
  });

  test("an override file can switch the job to color", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    await writeFile(join(dir, "color.yaml"), "color: color\n");
    const result = await invoke(["-y", "A.cpp"], dir, {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      XPRINT_CONFIG: "color.yaml",
    });
    expect(result.status).toBe(0);
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("ColorModel=RGB");
  });

  test("the contest config overrides the user config when no environment override is set", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    const userConfig = await userConfigPath(home);
    await mkdir(dirname(userConfig), { recursive: true });
    await writeFile(userConfig, "printer: HP_LaserJet\ncolor: monochrome\n");
    await writeFile(join(dir, ".xprint.yaml"), "color: color\n");
    const env: Record<string, string> = { PATH: `${binDir}:${process.env.PATH}`, HOME: home };
    const result = await invoke(["-y", "A.cpp"], dir, env);
    expect(result.status).toBe(0);
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("-d HP_LaserJet");
    expect(lpArgs).toContain("ColorModel=RGB");
    expect(lpArgs).not.toContain("ColorModel=Gray");
  });

  test("the nearest .xprint.yaml being a directory is rejected and no job is submitted", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await mkdir(join(dir, ".xprint.yaml"));
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}`, HOME: home });
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, ".xprint.yaml"));
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("the nearest contest config is found from a problem subdirectory and outer configs are ignored", async () => {
    const outer = await contestDir();
    const inner = join(outer, "A");
    await mkdir(inner);
    await writeFile(join(outer, ".xprint.yaml"), "printer: HP_LaserJet\ncontest: 外层\n");
    await writeFile(join(inner, ".xprint.yaml"), "printer: HP_ColorJet\ncontest: 内层\n");
    await writeFile(join(inner, "A.cpp"), "int main(){}\n");
    const capture = join(outer, "captured.pdf");
    const argsPath = join(outer, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const home = await mkdtemp(join(tmpdir(), "xprint-home-"));
    const result = await invoke(["-y", "A.cpp"], inner, { PATH: `${binDir}:${process.env.PATH}`, HOME: home });
    expect(result.status).toBe(0);
    expect(result.output).toContain("内层");
    expect(result.output).not.toContain("外层");
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("-d HP_ColorJet");
  });

  test("a YAML syntax error reports the file path, the line number and the reason", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await writeFile(join(dir, ".xprint.yaml"), "printer: HP_LaserJet\nprinter: Other\n");
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, ".xprint.yaml"));
    expect(result.output).toMatch(/第\s*2\s*行/);
    expect(result.output).toMatch(/Map keys must be unique/);
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("a field with the wrong type is rejected before any job is submitted", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await writeFile(join(dir, ".xprint.yaml"), "printer: 42\n");
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, ".xprint.yaml"));
    expect(result.output).toContain("printer");
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("an unknown field is rejected instead of being silently ignored", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await writeFile(join(dir, ".xprint.yaml"), "colour: color\n");
    const result = await invoke(["-y", "A.cpp"], dir, { PATH: `${binDir}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("colour");
    expect(await Bun.file(capture).exists()).toBe(false);
  });
});
