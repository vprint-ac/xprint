import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDefaultQueue, parseJobId, submitPdf } from "../src/cups.ts";

async function fakeBin(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "xprint-cups-"));
  const path = join(dir, "lp");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

describe("CUPS handoff", () => {
  test("resolves the system default queue from a localized lpstat -d line", async () => {
    expect(findDefaultQueue("系统默认目的位置：Practice_Printer\n")).toBe("Practice_Printer");
    expect(findDefaultQueue("system default destination: HP_LaserJet\n")).toBe("HP_LaserJet");
    expect(findDefaultQueue("no system default destination\n")).toBeNull();
    expect(findDefaultQueue("无系统默认目的位置\n")).toBeNull();
  });

  test("submitPdf passes the PDF via stdin with monochrome options and returns the job id", async () => {
    const lp = await fakeBin('#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE.args"\ncat > "$CAPTURE"\necho "request id is HP_DeskJet-123 (0 file(s))"\n');
    const capture = join(tmpdir(), `xprint-capture-${crypto.randomUUID()}.pdf`);
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
  });

  test("parseJobId accepts the localized and English request id formats", () => {
    expect(parseJobId("request id is HP_DeskJet-5 (0 file(s))")).toBe("HP_DeskJet-5");
    expect(parseJobId("request id is HP-7")).toBe("HP-7");
    expect(parseJobId("请求id是Practice_Printer-3（1个文件）")).toBe("Practice_Printer-3");
    expect(parseJobId("请求 id 是 Practice_Printer-3 (1 个文件)")).toBe("Practice_Printer-3");
    expect(parseJobId("")).toBeNull();
  });

  test("a lost connection after sending the PDF leaves the job status uncertain", async () => {
    const lp = await fakeBin('#!/bin/sh\ncat >/dev/null\necho "lp: Broken pipe" >&2\nexit 1\n');
    const receipt = submitPdf({ lp, queue: "Practice_Printer", pdf: new Uint8Array([37]), color: true, title: "A.cpp" });
    await expect(receipt).rejects.toMatchObject({ uncertain: true });
  });

  test("a rejected lp reports the backend reason and never retries", async () => {
    const lp = await fakeBin('#!/bin/sh\necho "lp: 打印机不可用" >&2\nexit 1\n');
    await expect(submitPdf({
      lp,
      queue: "Practice_Printer",
      pdf: new TextEncoder().encode("%PDF-1.7 fake"),
      color: false,
      title: "A.cpp",
    })).rejects.toThrow(/打印机不可用/);
  });
});
