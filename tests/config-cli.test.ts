import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userConfigPath } from "../src/config.ts";
import { pdfText } from "./support/poppler.ts";

const posix = process.platform !== "win32";
const bun = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));
let binary: string;
let work: string;
let isolatedHome: string;
let isolatedConfig: string;

beforeAll(async () => {
  if (!posix) return;
  work = await mkdtemp(join(tmpdir(), "xprint-config-cli-"));
  binary = join(work, "xprint");
  // Keep every test home away from the developer's real configuration.
  isolatedHome = join(work, "home");
  isolatedConfig = join(work, "xdg-config");
  await mkdir(isolatedHome);
  await mkdir(isolatedConfig);
  const build = spawnSync(bun, ["build", "src/index.ts", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
});

afterAll(async () => {
  if (!posix) return;
  await Bun.$`rm -rf ${work}`;
});

const knownQueues = ["Practice_Printer", "HP_LaserJet", "HP_ColorJet"];

async function fakeBackend(capturePath: string, argsPath: string) {
  const dir = join(work, "bin");
  await mkdir(dir, { recursive: true });
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

// A bare environment keeps the real user config, XDG config and any inherited
// XPRINT_CONFIG from affecting the test. PATH still reaches system tools.
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: isolatedHome, XDG_CONFIG_HOME: isolatedConfig, ...extra };
}

async function invoke(args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(binary, args, { cwd, env });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdin.end();
  const status = await new Promise<number | null>(resolve => child.once("close", resolve));
  return { status, output };
}

let fixtureIndex = 0;

async function contestDir(name = `contest-${fixtureIndex++}`) {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  const source = join(dir, "A.cpp");
  await writeFile(source, "int main(){}\n");
  return dir;
}

describe.skipIf(!posix)("xprint configuration", () => {
  test("with no configuration the system default queue is used in monochrome", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
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
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XPRINT_CONFIG: "missing.yaml" }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, "missing.yaml"));
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("user, nearest contest and environment layers override only their own fields", async () => {
    const outer = await contestDir("inherit-outer");
    const inner = join(outer, "A");
    await mkdir(inner);
    await writeFile(join(outer, ".xprint.yaml"), "printer: HP_ColorJet\ncolor: monochrome\ncontest: 外层\n");
    await writeFile(join(inner, ".xprint.yaml"), "color: color\ncontest: 内层\nlocation: \"007\"\n");
    await writeFile(join(inner, "A.cpp"), "int main(){}\n");
    const userConfig = userConfigPath(isolatedEnv());
    await mkdir(dirname(userConfig), { recursive: true });
    await writeFile(userConfig, "printer: HP_ColorJet\nteam: 校队\n");
    await writeFile(join(inner, "mono.yaml"), "printer: HP_LaserJet\n");
    const capture = join(inner, "captured.pdf");
    const argsPath = join(inner, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const result = await invoke(["-y", "A.cpp"], inner, isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`,
      XPRINT_CONFIG: "mono.yaml",
    }));
    expect(result.status).toBe(0);
    // The outer layer is ignored entirely; the user team still survives.
    expect(result.output).toContain("内层");
    expect(result.output).not.toContain("外层");
    expect(result.output).toContain("HP_LaserJet");
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("-d HP_LaserJet");
    // Color comes from the nearest contest layer, which the empty override keeps.
    expect(lpArgs).toContain("ColorModel=RGB");
    const pdf = new Uint8Array(await Bun.file(capture).arrayBuffer());
    const text = pdfText(pdf);
    expect(text).toContain("校队");
    expect(text).toContain("007");
  });

  test("an override file can switch the job to color", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    await writeFile(join(dir, "color.yaml"), "color: color\n");
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`,
      XPRINT_CONFIG: "color.yaml",
    }));
    expect(result.status).toBe(0);
    const lpArgs = await Bun.file(argsPath).text();
    expect(lpArgs).toContain("ColorModel=RGB");
  });

  test("the contest config overrides the user config when no environment override is set", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const argsPath = join(dir, "lp-args.txt");
    const binDir = await fakeBackend(capture, argsPath);
    const userConfig = userConfigPath(isolatedEnv());
    await mkdir(dirname(userConfig), { recursive: true });
    await writeFile(userConfig, "printer: HP_LaserJet\ncolor: monochrome\n");
    await writeFile(join(dir, ".xprint.yaml"), "color: color\n");
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
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
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, ".xprint.yaml"));
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("a YAML syntax error reports the file path, the line number and the reason", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await writeFile(join(dir, ".xprint.yaml"), "printer: HP_LaserJet\nprinter: Other\n");
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
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
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
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
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("colour");
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  test("a config path whose parent is a file is reported with that path in Chinese", async () => {
    const dir = await contestDir();
    const capture = join(dir, "captured.pdf");
    const binDir = await fakeBackend(capture, join(dir, "lp-args.txt"));
    await writeFile(join(dir, "not-a-directory"), "");
    const result = await invoke(["-y", "A.cpp"], dir, isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`,
      XPRINT_CONFIG: "not-a-directory/config.yaml",
    }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(join(dir, "not-a-directory", "config.yaml"));
    expect(result.output).toContain("不是目录");
    expect(await Bun.file(capture).exists()).toBe(false);
  });
});
