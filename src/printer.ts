import { platform } from "node:os";
import * as cups from "./cups.ts";
import * as windows from "./windows.ts";

export { PrintBackendError } from "./cups.ts";
export type { SubmitOptions, SubmitResult } from "./cups.ts";

export async function resolveQueue(requested: string | undefined) {
  return platform() === "win32" ? windows.resolveQueue(requested) : cups.resolveQueue(requested);
}

export async function submitPdf(options: cups.SubmitOptions & windows.WindowsBackendOptions): Promise<cups.SubmitResult> {
  return platform() === "win32" ? windows.submitPdf(options) : cups.submitPdf(options);
}
