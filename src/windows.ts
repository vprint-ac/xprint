import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import manifest from "../windows/sumatra.json" with { type: "json" };
import { PrintBackendError, type SubmitResult } from "./cups.ts";

export { PrintBackendError };
export type { SubmitResult };

const POWERSHELL_UTF8 = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;";

const LIST_QUEUES_SCRIPT = POWERSHELL_UTF8 + " Get-Printer | Select-Object -ExpandProperty Name";

const DEFAULT_QUEUE_SCRIPT = POWERSHELL_UTF8 + " (Get-CimInstance Win32_Printer | Where-Object Default).Name";

// Windows limits each path component to 255 UTF-16 code units. Keeping the
// spool file's name close to the source name makes the job recognizable in the
// print queue without risking a failed SumatraPDF launch.
const maxSpoolFilenameLength = 255;

export interface WindowsSubmitOptions {
  sumatra?: string;
  queue: string;
  pdf: Uint8Array;
  color: boolean;
  title: string;
  env?: Record<string, string>;
}

export interface WindowsBackendOptions {
  powershell?: string;
  sumatra?: string;
}

export const SUMATRA_PDF = manifest;

export function sumatraPath(executable: string = process.execPath) {
  return join(dirname(executable), SUMATRA_PDF.exe);
}

function detail(result: { code: number; stdout: string; stderr: string }) {
  return (result.stderr || result.stdout).trim() || `退出码 ${result.code}`;
}

function missingToolError(tool: string, reason: string): PrintBackendError {
  return new PrintBackendError(
    `找不到 ${tool}（${reason}）。请确认它已安装或在 PATH 中，或检查发行包是否完整。`,
    false,
  );
}

// Node's spawn emits an ENOENT error event on Windows and macOS. On Linux it
// can instead resolve with exit code 127 and no output, so confirm the tool is
// really absent before calling it missing; a genuine 127 from an existing
// executable stays a backend failure.
function exitedBecauseMissing(command: string, result: { code: number; stdout: string; stderr: string }) {
  return result.code === 127 && !result.stdout && !result.stderr && !Bun.which(command);
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // Decode only after the process has exited: a multi-byte UTF-8 character
    // can be split across pipe chunks, and decoding each chunk on its own would
    // corrupt queue names that contain Chinese.
    child.stdout.on("data", chunk => { stdoutChunks.push(chunk); });
    child.stderr.on("data", chunk => { stderrChunks.push(chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") reject(missingToolError(command, error.message));
      else reject(error);
    });
    child.once("close", code => {
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (exitedBecauseMissing(command, result)) {
        reject(missingToolError(command, "退出码 127，且 PATH 中找不到该程序"));
        return;
      }
      resolve(result);
    });
  });
}

export function parsePrinterNames(output: string) {
  return output.split(/\r?\n/u).map(name => name.trim()).filter(Boolean);
}

export async function listQueues(env: Record<string, string> = {}, powershell: string = "powershell.exe") {
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", LIST_QUEUES_SCRIPT], env);
  if (result.code !== 0) {
    throw new PrintBackendError(
      `无法枚举 Windows 打印队列（${powershell} 退出码 ${result.code}）：${detail(result)}。请确认 Print Spooler 服务正在运行，或在配置中显式指定 printer。`,
      false,
    );
  }
  return parsePrinterNames(result.stdout);
}

export async function defaultQueue(env: Record<string, string> = {}, powershell: string = "powershell.exe") {
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", DEFAULT_QUEUE_SCRIPT], env);
  if (result.code !== 0 || !result.stdout.trim()) {
    if (result.code !== 0) {
      throw new PrintBackendError(
        `无法读取 Windows 默认打印队列（${powershell} 退出码 ${result.code}）：${detail(result)}。请确认 Print Spooler 服务正在运行，或在配置中显式指定 printer。`,
        false,
      );
    }
    return null;
  }
  return parsePrinterNames(result.stdout)[0];
}

export function sumatraArguments(options: WindowsSubmitOptions) {
  // "1x" makes SumatraPDF set dmCopies=1 and the DM_COPIES flag. Without it the
  // driver's own default (which may be more than one copy) is left in place.
  return [
    "-print-to", options.queue,
    "-silent",
    "-print-settings", `paper=A4,1x,${options.color ? "color" : "monochrome"}`,
  ];
}

export function spoolFilename(title: string) {
  // Windows silently strips trailing dots and spaces, and refuses the legacy
  // device names (CON, NUL, COM1, ...) even with an extension.
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
  const stem = base.replace(/\.pdf$/iu, "") || "printout";
  const safeStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem) ? `_${stem}` : stem;
  return `${safeStem.slice(0, maxSpoolFilenameLength - 4)}.pdf`;
}

export async function submitPdf(options: WindowsSubmitOptions): Promise<SubmitResult> {
  const dir = await mkdtemp(join(tmpdir(), "xprint-"));
  const pdfPath = join(dir, spoolFilename(options.title));
  try {
    await writeFile(pdfPath, options.pdf);
    const args = [...sumatraArguments(options), pdfPath];
    const sumatra = options.sumatra ?? sumatraPath();
    const result = await run(sumatra, args, options.env ?? {});
    if (result.code !== 0) {
      throw new PrintBackendError(
        `打印后端拒绝作业：${detail(result)}。`,
        result.code === -1 || /timed? ?out|连接|busy/iu.test(detail(result)),
      );
    }
    return { jobId: null };
  } finally {
    // A spooler or antivirus may hold the PDF open briefly after SumatraPDF
    // exits. Cleanup is best effort and must never change the submit outcome.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error: Error) => {
      process.emitWarning(`打印临时文件「${dir}」未能清理，系统可稍后自动删除。${error.message}`, { code: "XPRINT_TMP_CLEANUP" });
    });
  }
}
