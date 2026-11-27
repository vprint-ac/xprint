import { platform } from "node:os";
import {
  PrintBackendError,
  defaultQueue as cupsDefaultQueue,
  listQueues as cupsListQueues,
  submitPdf as cupsSubmitPdf,
  type QueueOverrides,
  type SubmitOptions,
  type SubmitResult,
} from "./cups.ts";
import {
  defaultQueue as windowsDefaultQueue,
  listQueues as windowsListQueues,
  submitPdf as windowsSubmitPdf,
  type WindowsBackendOptions,
  type WindowsSubmitOptions,
} from "./windows.ts";

export { PrintBackendError } from "./cups.ts";
export type { SubmitOptions, SubmitResult } from "./cups.ts";

export interface BackendOptions extends QueueOverrides, WindowsBackendOptions {
  // Tests use this to select a backend whose shell mocks run on another host.
  // Production callers leave it unset and get the current platform.
  platform?: "cups" | "windows";
}

async function selectQueue(
  requested: string | undefined,
  defaultQueue: () => Promise<string | null>,
  listQueues: () => Promise<string[]>,
) {
  const queue = requested || await defaultQueue();
  if (!queue) throw new PrintBackendError("没有系统默认打印队列，请在用户配置中指定 printer。", false);
  const queues = await listQueues();
  if (!queues.includes(queue)) {
    throw new PrintBackendError(`系统队列「${queue}」不存在，请核对配置。`, false);
  }
  return queue;
}

function useWindows(overrides: BackendOptions) {
  if (overrides.platform) return overrides.platform === "windows";
  return platform() === "win32";
}

export async function resolveQueue(requested: string | undefined, overrides: BackendOptions = {}) {
  return useWindows(overrides)
    ? selectQueue(requested, () => windowsDefaultQueue({}, overrides.powershell), () => windowsListQueues({}, overrides.powershell))
    : selectQueue(requested, () => cupsDefaultQueue({}, overrides.lpstat), () => cupsListQueues({}, overrides.lpstat));
}

export async function submitPdf(options: SubmitOptions & WindowsSubmitOptions): Promise<SubmitResult> {
  return platform() === "win32" ? windowsSubmitPdf(options) : cupsSubmitPdf(options);
}
