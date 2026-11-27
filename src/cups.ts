export interface SubmitOptions {
  lp?: string;
  queue: string;
  pdf: Uint8Array;
  color: boolean;
  title: string;
  env?: Record<string, string>;
}

export interface SubmitResult {
  jobId: string | null;
}

export interface QueueOverrides {
  lpstat?: string;
}

export class PrintBackendError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
    this.name = "PrintBackendError";
  }
}

function missingToolError(tool: string, reason: string): PrintBackendError {
  return new PrintBackendError(
    `找不到 ${tool}（${reason}）。Linux 与 macOS 通过 CUPS 提交打印，请确认已安装 CUPS 客户端工具（lp、lpstat）并已加入 PATH。`,
    false,
  );
}

// Bun.spawn reports a missing executable in two different ways: on macOS it
// throws ENOENT synchronously, while on Linux it resolves to exit code 127
// with empty output. A genuine exit 127 from an existing executable is kept as
// a backend failure, so the 127 check must confirm the tool is actually absent.
function exitedBecauseMissing(command: string, result: { code: number; stdout: string; stderr: string }) {
  return result.code === 127 && !result.stdout && !result.stderr && !Bun.which(command);
}

async function run(command: string, args: string[], input?: Uint8Array, env: Record<string, string> = {}) {
  try {
    const processHandle = Bun.spawn([command, ...args], {
      stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...env, LC_ALL: "C" },
    });
    const [code, stdout, stderr] = await Promise.all([
      processHandle.exited, processHandle.stdout.text(), processHandle.stderr.text(),
    ]);
    if (exitedBecauseMissing(command, { code, stdout, stderr })) throw missingToolError(command, "退出码 127，且 PATH 中找不到该程序");
    return { code, stdout, stderr, signal: processHandle.signalCode };
  } catch (error) {
    if (error instanceof PrintBackendError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw missingToolError(command, (error as Error).message);
    }
    throw error;
  }
}

export function findDefaultQueue(lpstatOutput: string) {
  // Both "system default destination: X" and the localized "系统默认目的位置：X"
  // end with the queue name after a colon; "no system default destination" has none.
  const match = /[:：]\s*(\S+)\s*$/u.exec(lpstatOutput.trim());
  return match ? match[1] : null;
}

export async function listQueues(env: Record<string, string> = {}, lpstat = "lpstat") {
  const result = await run(lpstat, ["-e"], undefined, env);
  if (result.code !== 0) throw new PrintBackendError(`无法查询 CUPS 打印队列：${result.stderr.trim() || `lpstat 退出码 ${result.code}`}`, false);
  return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
}

export async function defaultQueue(env: Record<string, string> = {}, lpstat = "lpstat") {
  const result = await run(lpstat, ["-d"], undefined, env);
  return result.code === 0 ? findDefaultQueue(result.stdout) : null;
}

export async function resolveQueue(requested: string | undefined, overrides: QueueOverrides = {}) {
  const queue = requested || await defaultQueue({}, overrides.lpstat);
  if (!queue) throw new PrintBackendError("没有系统默认打印队列，请在用户配置中指定 printer。", false);
  const queues = await listQueues({}, overrides.lpstat);
  if (!queues.includes(queue)) {
    throw new PrintBackendError(`系统队列「${queue}」不存在，请核对配置。`, false);
  }
  return queue;
}

export function parseJobId(output: string) {
  // English: "request id is X (1 file(s))". Localized macOS: "请求id是X（1个文件）".
  return /(?:request\s+id\s+is|请求\s*id\s*是)\s*(\S+?)(?=[\s(（]|$)/iu.exec(output)?.[1] ?? null;
}

export async function submitPdf(options: SubmitOptions): Promise<SubmitResult> {
  const args = [
    "-d", options.queue,
    "-t", options.title,
    "-o", "media=A4",
    "-o", `ColorModel=${options.color ? "RGB" : "Gray"}`,
    "-o", `print-color-mode=${options.color ? "color" : "monochrome"}`,
    "-n", "1",
  ];
  const result = await run(options.lp ?? "lp", args, options.pdf, options.env);
  if (result.code === 0) return { jobId: parseJobId(result.stdout + result.stderr) };
  const detail = (result.stderr || result.stdout).trim();
  const uncertain = Boolean(result.signal) || /timed? ?out|connect|broken pipe|busy|service-unavailable/iu.test(detail);
  throw new PrintBackendError(
    `${uncertain ? "打印后端连接中断" : "打印后端拒绝作业"}：${detail || `lp 退出码 ${result.code}`}。`,
    uncertain,
  );
}
