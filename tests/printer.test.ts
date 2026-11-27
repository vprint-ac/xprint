import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listQueues, PrintBackendError, resolveQueue, submitPdf, sumatraArguments, sumatraPath } from "../src/windows.ts";

async function fakeExecutable(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-win-"));
  const path = join(dir, "backend");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

describe("Windows printing handoff", () => {
  test("resolveQueue uses the system default queue when no queue is configured", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
printf 'Microsoft Print to PDF\\r\\n'
`);
    expect(await resolveQueue(undefined, { powershell })).toBe("Microsoft Print to PDF");
  });

  test("resolveQueue keeps a configured queue whose name contains spaces and Chinese", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
if printf '%s' "$*" | grep -q -- 'Get-Printer'; then
  printf 'Microsoft Print to PDF\\r\\n'
  printf 'xprint-ci 中文 队列\\r\\n'
fi
`);
    expect(await resolveQueue("xprint-ci 中文 队列", { powershell })).toBe("xprint-ci 中文 队列");
  });

  test("resolveQueue rejects a configured queue that does not exist", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
printf 'Microsoft Print to PDF\\r\\n'
`);
    await expect(resolveQueue("Missing_Queue", { powershell })).rejects.toThrow(/Missing_Queue/);
  });

  test("a failed PowerShell query reports the service to check instead of a bare exit code", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
echo 'Get-Printer : The spooler service is not running.' >&2
exit 1
`);
    await expect(listQueues({ }, powershell)).rejects.toThrow(/无法枚举 Windows 打印队列.*Print Spooler.*指定 printer/s);
    await expect(resolveQueue(undefined, { powershell })).rejects.toThrow(/无法读取 Windows 默认打印队列.*spooler service is not running.*指定 printer/s);
  });

  test("queue names split across pipe chunks are decoded as one UTF-8 stream", async () => {
    const powershell = await fakeExecutable(`#!/bin/sh
# POSIX octal escapes only: dash's printf lacks hex escapes.
printf 'Microsoft Print to PDF\\r\\nxprint-ci '
printf '\\344\\270'
sleep 0.2
printf '\\255\\346\\226\\207 \\351\\230\\237\\345\\210\\227\\r\\n'
`);
    expect(await listQueues({ }, powershell)).toEqual(["Microsoft Print to PDF", "xprint-ci 中文 队列"]);
  });

  test("PowerShell queries force UTF-8 console output and keep the script fixed", async () => {
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

  test("submitPdf hands the PDF to the bundled SumatraPDF and returns no job id", async () => {
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
    expect(seen).toContain("%PDF-1.7 real");
    expect(await Bun.file(pdfPath).exists()).toBe(false);
  });

  test("submitPdf reports a backend rejection without retrying or inventing a job id", async () => {
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
});
