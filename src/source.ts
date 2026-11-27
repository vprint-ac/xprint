import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";

export const maxSourceBytes = 16_384;

// Adapted from Hydro/XCPC-TOOLS printer.ts: characters that are not letters,
// marks, numbers, punctuation, symbols, CR, LF, tab or space are shown as
// visible escapes so control and bidi characters cannot disappear on paper.
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\r\n\t ]$/u;

export function escapeSourceText(text: string) {
  let escaped = "";
  for (const character of text) {
    escaped += printable.test(character) ? character : `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`;
  }
  return escaped;
}

export interface SourceSnapshot {
  filename: string;
  bytes: Uint8Array;
  text: string;
  mtime: Date;
}

function formatBytes(count: number) {
  return count.toLocaleString("en-US");
}

export function decodeSourceText(bytes: Uint8Array) {
  if (bytes.byteLength > maxSourceBytes) {
    throw new Error(`文件共 ${formatBytes(bytes.byteLength)} 字节，超过单个文件 ${formatBytes(maxSourceBytes)} 字节的上限。`);
  }
  let text: string;
  try {
    // A leading BOM is part of the byte count but is not source content, so it
    // is dropped from the decoded text instead of being printed as U+FEFF.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("仅支持 UTF-8 纯文本。");
  }
  // C0 control characters (other than tab and line breaks) still mean binary
  // input. Everything else is kept and shown as a visible escape by
  // escapeSourceText, matching Hydro/XCPC-TOOLS.
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(text)) throw new Error("仅支持 UTF-8 纯文本。");
  return text;
}

export async function readSource(path: string): Promise<SourceSnapshot> {
  // A FIFO must reach the regular-file check without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("请选择普通文件。");
    const buffer = new Uint8Array(maxSourceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    // A settled file reports its real size from stat().size. The read stays
    // bounded at one byte past the limit so a growing file cannot make the
    // check read without limit, so a file that grew past the limit mid-read
    // falls back to the bytes actually observed.
    if (size > maxSourceBytes) {
      throw new Error(`文件共 ${formatBytes(Math.max(metadata.size, size))} 字节，超过单个文件 ${formatBytes(maxSourceBytes)} 字节的上限。`);
    }
    return { filename: basename(path), bytes, text: decodeSourceText(bytes), mtime: metadata.mtime };
  } finally {
    await file.close();
  }
}
