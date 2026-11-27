import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listQueues,
  PrintBackendError,
  spoolFilename,
  submitPdf,
  sumatraArguments,
  sumatraPath,
} from "../src/windows.ts";
import { resolveQueue } from "../src/printer.ts";

// The shell mocks below need a POSIX sh. Windows runs the real backend through
// windows/acceptance.ps1 instead.
const posix = process.platform !== "win32";
// The read-only directory fixture cannot deny root, so that test needs an
// unprivileged user.
const canDenyWrites = typeof process.getuid === "function" && process.getuid() !== 0;

async function fakeExecutable(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-win-"));
  const path = join(dir, "backend");
  await writeFile(path, script);
  if (posix) await chmod(path, 0o755);
  return path;
}

describe("Windows printing handoff", () => {
  test.skipIf(!posix)("resolveQueue uses the system default queue when no queue is configured", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
printf 'Microsoft Print to PDF\\r\\n'
`);
    expect(await resolveQueue(undefined, { platform: "windows", powershell })).toBe("Microsoft Print to PDF");
  });

  test.skipIf(!posix)("resolveQueue keeps a configured queue whose name contains spaces and Chinese", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
if printf '%s' "$*" | grep -q -- 'Get-Printer'; then
  printf 'Microsoft Print to PDF\\r\\n'
  printf 'xprint-ci 中文 队列\\r\\n'
fi
`);
    expect(await resolveQueue("xprint-ci 中文 队列", { platform: "windows", powershell })).toBe("xprint-ci 中文 队列");
  });

  test.skipIf(!posix)("resolveQueue rejects a configured queue that does not exist", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
printf 'Microsoft Print to PDF\\r\\n'
`);
    await expect(resolveQueue("Missing_Queue", { platform: "windows", powershell })).rejects.toThrow(/Missing_Queue/);
  });

  test.skipIf(!posix)("a failed PowerShell query reports the service to check instead of a bare exit code", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
echo 'Get-Printer : The spooler service is not running.' >&2
exit 1
`);
    await expect(listQueues({ }, powershell)).rejects.toThrow(/无法枚举 Windows 打印队列.*Print Spooler.*指定 printer/s);
    await expect(resolveQueue(undefined, { platform: "windows", powershell })).rejects.toThrow(/无法读取 Windows 默认打印队列.*spooler service is not running.*指定 printer/s);
  });

  test("a missing PowerShell is reported as an actionable Chinese error", async () => {
    const missing = join(tmpdir(), `xprint-missing-${crypto.randomUUID()}`, "powershell.exe");
    const error = await listQueues({}, missing).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrintBackendError);
    expect((error as Error).message).toContain(`找不到 ${missing}`);
    expect((error as Error).message).toContain("发行包");
    expect((error as PrintBackendError).uncertain).toBe(false);
  });

  test.skipIf(!posix)("queue names split across pipe chunks are decoded as one UTF-8 stream", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
# POSIX octal escapes only: dash's printf lacks hex escapes.
printf 'Microsoft Print to PDF\\r\\nxprint-ci '
printf '\\344\\270'
sleep 0.2
printf '\\255\\346\\226\\207 \\351\\230\\237\\345\\210\\227\\r\\n'
`);
    expect(await listQueues({ }, powershell)).toEqual(["Microsoft Print to PDF", "xprint-ci 中文 队列"]);
  });

  test.skipIf(!posix)("PowerShell queries force UTF-8 console output and keep the script fixed", async () => {
    const calls = await mkdtemp(join(tmpdir(), "xprint-win-"));
    const capture = join(calls, "calls.txt");
    const powershell = await fakeExecutable(`#!/bin/sh
printf '%s\\n' "$@" > "${capture}"
printf 'Microsoft Print to PDF\\r\\n'
`);
    await listQueues({ }, powershell);
    const args = (await Bun.file(capture).text()).split("\n").filter(Boolean);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    const script = args[args.indexOf("-Command") + 1];
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    expect(script).toContain("Get-Printer");
  });

  test("sumatraPath resolves the real executable next to the running CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-win-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    const exe = join(bin, "xprint.exe");
    await writeFile(exe, "");
    const sumatra = join(bin, "SumatraPDF-3.6.1-64.exe");
    await writeFile(sumatra, "");
    expect(sumatraPath(exe)).toBe(sumatra);
  });

  test("sumatraArguments passes the queue and color request without a dialog", () => {
    const args = sumatraArguments({ queue: "xprint-ci 中文 队列", pdf: new Uint8Array(), color: false, title: "A.cpp" });
    expect(args[args.indexOf("-print-to") + 1]).toBe("xprint-ci 中文 队列");
    expect(args[args.indexOf("-print-settings") + 1]).toBe("paper=A4,1x,monochrome");
    const colorArgs = sumatraArguments({ queue: "q", pdf: new Uint8Array(), color: true, title: "A.cpp" });
    expect(colorArgs[colorArgs.indexOf("-print-settings") + 1]).toBe("paper=A4,1x,color");
    expect(args).toContain("-silent");
  });

  test("the spool file is named after the source within the Windows component limit", () => {
    expect(spoolFilename("A.cpp")).toBe("A.cpp.pdf");
    expect(spoolFilename("solution.pdf")).toBe("solution.pdf");
    expect(spoolFilename("中文 题.cpp")).toBe("中文 题.cpp.pdf");
    expect(spoolFilename("a<b:c>d\"e/f\\g|h?i*.cpp")).toBe("a_b_c_d_e_f_g_h_i_.cpp.pdf");
    expect(spoolFilename("...")).toBe("printout.pdf");
    expect(spoolFilename("CON")).toBe("_CON.pdf");
    expect(spoolFilename(`${"长".repeat(300)}.cpp`)).toBe(`${"长".repeat(251)}.pdf`);
  });

  test.skipIf(!posix)("submitPdf hands the PDF to the bundled SumatraPDF and returns no job id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-win-"));
    const capture = join(dir, "capture.txt");
    const sumatra = await fakeExecutable(`#!/bin/sh
for last; do :; done
printf '%s\\n' "$last" > "${capture}"
cat "$last" >> "${capture}"
`);
    const result = await submitPdf({
      sumatra,
      queue: "xprint-ci 中文 队列",
      pdf: new TextEncoder().encode("%PDF-1.7 real"),
      color: true,
      title: "A.cpp",
    });
    expect(result.jobId).toBeNull();
    const seen = await Bun.file(capture).text();
    const pdfPath = seen.split("\n")[0];
    expect(pdfPath.endsWith("A.cpp.pdf")).toBe(true);
    expect(seen).toContain("%PDF-1.7 real");
    expect(await Bun.file(pdfPath).exists()).toBe(false);
  });

  test.skipIf(!posix)("submitPdf reports a backend rejection without retrying or inventing a job id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xprint-win-"));
    const calls = join(dir, "calls.txt");
    const sumatra = await fakeExecutable(`#!/bin/sh
echo x >> "${calls}"
exit 3
`);
    let thrown: unknown;
    try {
      await submitPdf({ sumatra, queue: "Microsoft Print to PDF", pdf: new TextEncoder().encode("%PDF-1.7"), color: false, title: "A.cpp" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PrintBackendError);
    expect((thrown as PrintBackendError).uncertain).toBe(false);
    expect((thrown as Error).message).toMatch(/退出码 3/);
    expect((await Bun.file(calls).text()).trim()).toBe("x");
  });

  test.skipIf(!posix)("a missing SumatraPDF is reported as an actionable Chinese error and no temp file is left behind", async () => {
    const missing = join(tmpdir(), `xprint-missing-${crypto.randomUUID()}`, "SumatraPDF.exe");
    const error = await submitPdf({ sumatra: missing, queue: "q", pdf: new Uint8Array([37]), color: false, title: "A.cpp" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrintBackendError);
    expect((error as Error).message).toContain(`找不到 ${missing}`);
    expect((error as PrintBackendError).uncertain).toBe(false);
  });

  test.skipIf(!posix || !canDenyWrites)("a temp directory that stays locked after an accepted job produces a warning, not a failure", async () => {
    // SumatraPDF "accepts" the job, then makes the containing directory
    // read-only so the cleanup cannot remove the spool file. The accepted
    // result must survive that failure.
    const sumatra = await fakeExecutable(`#!/bin/sh
for last; do :; done
chmod 500 "$(dirname "$last")"
`);
    const warnings: string[] = [];
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => {
      warnings.push(String(warning));
    }) as typeof process.emitWarning;
    let lockedDirectory: string | undefined;
    try {
      const result = await submitPdf({ sumatra, queue: "q", pdf: new Uint8Array([37]), color: false, title: "A.cpp" });
      expect(result).toEqual({ jobId: null });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("未能清理");
      expect(warnings[0]).toContain("xprint-");
      lockedDirectory = warnings[0].match(/「([^」]+)」/u)![1];
    } finally {
      process.emitWarning = originalEmitWarning;
      if (lockedDirectory) {
        await chmod(lockedDirectory, 0o700);
        await rm(lockedDirectory, { recursive: true, force: true });
      }
    }
  });
});
