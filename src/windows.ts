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

function run(command: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // Decode only after the process has exited: a multi-byte UTF-8 character
    // can be split across pipe chunks, and decoding each chunk on its own would
    // corrupt queue names that contain Chinese.
    child.stdout.on("data", chunk => { stdoutChunks.push(chunk); });
    child.stderr.on("data", chunk => { stderrChunks.push(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    }));
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

export async function resolveQueue(requested: string | undefined, overrides: WindowsBackendOptions = {}) {
  const queue = requested || await defaultQueue({}, overrides.powershell);
  if (!queue) throw new PrintBackendError("没有系统默认打印队列，请在用户配置中指定 printer。", false);
  const queues = await listQueues({}, overrides.powershell);
  if (!queues.includes(queue)) {
    throw new PrintBackendError(`系统队列「${queue}」不存在，请核对配置。`, false);
  }
  return queue;
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

export async function submitPdf(options: WindowsSubmitOptions): Promise<SubmitResult> {
  const dir = await mkdtemp(join(tmpdir(), "xprint-"));
  const pdfPath = join(dir, "printout.pdf");
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
    await rm(dir, { recursive: true, force: true });
  }
}
