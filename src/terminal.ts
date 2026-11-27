import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { SelectKeyPrompt } from "@clack/core";
import { log, S_INFO } from "@clack/prompts";

export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

export function terminalLabel(value: string) {
  return value.replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function confirmPrint(input: Readable = process.stdin, output: Writable = process.stdout) {
  const prompt = new SelectKeyPrompt({
    input, output,
    options: [{ value: "y" }, { value: "n" }],
    caseSensitive: false,
    render: () => styleText("blue", S_INFO) + "  确认打印？ [Y/n]",
  });
  // SelectKeyPrompt's initialValue sets only the cursor. Enter submits value.
  prompt.value = "y";
  return prompt.prompt();
}

export function report(kind: "info" | "success" | "warn" | "error", message: string) {
  const output = kind === "error" ? process.stderr : process.stdout;
  log[kind](message, { output, withGuide: interactive && Boolean(output.isTTY), spacing: 0 });
}

export function localTime(date: Date | number) {
  return new Date(date).toLocaleString("zh-CN", { hour12: false });
}

export function formatFileAge(ageMs: number) {
  let seconds = Math.floor(Math.abs(ageMs) / 1000);
  if (seconds === 0) return "0 秒前";
  const parts: string[] = [];
  for (const [unit, length] of [["天", 86400], ["小时", 3600], ["分钟", 60], ["秒", 1]] as const) {
    const count = Math.floor(seconds / length);
    if (count > 0) parts.push(`${count} ${unit}`);
    seconds %= length;
  }
  return parts.join(" ") + (ageMs < 0 ? "后" : "前");
}
