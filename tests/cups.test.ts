import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDefaultQueue, listQueues, parseJobId, PrintBackendError, submitPdf } from "../src/cups.ts";

// The POSIX shell mocks below cannot execute on Windows. The real Windows
// backend is covered by tests/printer.test.ts and windows/acceptance.ps1.
const posix = process.platform !== "win32";

async function fakeBin(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-cups-"));
  const path = join(dir, "lp");
  await writeFile(path, script);
  if (posix) await chmod(path, 0o755);
  return path;
}

describe("CUPS handoff", () => {
  test("resolves the system default queue from a localized lpstat -d line", () => {
    expect(findDefaultQueue("系统默认目的位置：Practice_Printer\n")).toBe("Practice_Printer");
    expect(findDefaultQueue("system default destination: HP_LaserJet\n")).toBe("HP_LaserJet");
    expect(findDefaultQueue("no system default destination\n")).toBeNull();
    expect(findDefaultQueue("无系统默认目的位置\n")).toBeNull();
  });

  test.skipIf(!posix)("submitPdf passes the PDF via stdin with monochrome options and returns the job id", async () => {
    const capture = join(tmpdir(), `xprint-capture-${crypto.randomUUID()}.pdf`);
    const lp = await fakeBin('#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE.args"\ncat > "$CAPTURE"\necho "request id is HP_DeskJet-123 (0 file(s))"\n');
    const pdf = new TextEncoder().encode("%PDF-1.7 fake");
    const result = await submitPdf({
      lp,
      queue: "Practice_Printer",
      pdf,
      color: false,
      title: "A.cpp",
      env: { CAPTURE: capture },
    });
    expect(result.jobId).toBe("HP_DeskJet-123");
    const args = (await Bun.file(capture + ".args").text()).trimEnd().split("\n");
    expect(args).toContain("print-color-mode=monochrome");
    expect(args).toContain("media=A4");
    expect(args.slice(args.indexOf("-n"), args.indexOf("-n") + 2)).toEqual(["-n", "1"]);
    expect((await Bun.file(capture).arrayBuffer()).byteLength).toBe(pdf.byteLength);
    await Bun.$`rm -f ${capture} ${capture + ".args"}`;
  });

  test("parseJobId accepts the localized and English request id formats", () => {
    expect(parseJobId("request id is HP_DeskJet-5 (0 file(s))")).toBe("HP_DeskJet-5");
    expect(parseJobId("request id is HP-7")).toBe("HP-7");
    expect(parseJobId("请求id是Practice_Printer-3（1个文件）")).toBe("Practice_Printer-3");
    expect(parseJobId("请求 id 是 Practice_Printer-3 (1 个文件)")).toBe("Practice_Printer-3");
    expect(parseJobId("")).toBeNull();
  });

  test.skipIf(!posix)("a lost connection after sending the PDF leaves the job status uncertain", async () => {
    const lp = await fakeBin('#!/bin/sh\ncat >/dev/null\necho "lp: Broken pipe" >&2\nexit 1\n');
    const receipt = submitPdf({ lp, queue: "Practice_Printer", pdf: new Uint8Array([37]), color: true, title: "A.cpp" });
    await expect(receipt).rejects.toMatchObject({ uncertain: true });
  });

  test.skipIf(!posix)("a rejected lp reports the backend reason and never retries", async () => {
    const lp = await fakeBin('#!/bin/sh\necho "lp: 打印机不可用" >&2\nexit 1\n');
    await expect(submitPdf({
      lp,
      queue: "Practice_Printer",
      pdf: new TextEncoder().encode("%PDF-1.7 fake"),
      color: false,
      title: "A.cpp",
    })).rejects.toThrow(/打印机不可用/);
  });

  test.skipIf(!posix)("an existing lp that exits 127 keeps its real reason instead of being reported as missing", async () => {
    const lp = await fakeBin('#!/bin/sh\necho "lp: unsupported option" >&2\nexit 127\n');
    const error = await submitPdf({
      lp,
      queue: "Practice_Printer",
      pdf: new TextEncoder().encode("%PDF-1.7 fake"),
      color: false,
      title: "A.cpp",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrintBackendError);
    expect((error as Error).message).toContain("unsupported option");
    expect((error as Error).message).not.toContain("找不到");
  });

  test("a missing lpstat is reported as an actionable Chinese error", async () => {
    const missing = join(tmpdir(), `xprint-missing-${crypto.randomUUID()}`, "lpstat");
    const error = await listQueues({}, missing).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrintBackendError);
    expect((error as Error).message).toContain(`找不到 ${missing}`);
    expect((error as Error).message).toContain("CUPS");
    expect((error as PrintBackendError).uncertain).toBe(false);
  });

  test("a missing lp is reported as an actionable Chinese error", async () => {
    const missing = join(tmpdir(), `xprint-missing-${crypto.randomUUID()}`, "lp");
    const error = await submitPdf({ lp: missing, queue: "Practice_Printer", pdf: new Uint8Array([37]), color: false, title: "A.cpp" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrintBackendError);
    expect((error as Error).message).toContain("找不到 " + missing);
    expect((error as PrintBackendError).uncertain).toBe(false);
  });
});
