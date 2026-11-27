import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxSourceBytes, readSource } from "../src/source.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "xprint-source-"));
  return (name: string, content: string | Uint8Array) => {
    const path = join(dir, name);
    return writeFile(path, content).then(() => path);
  };
}

describe("readSource", () => {
  test("accepts exactly 16,384 raw bytes including a BOM and CRLF", async () => {
    const put = await fixture();
    const bytes = new Uint8Array(maxSourceBytes);
    const prefix = new TextEncoder().encode("\uFEFF// 中文\r\n");
    bytes.set(prefix);
    bytes.fill(0x61, prefix.byteLength);
    const path = await put("A.cpp", bytes);
    const source = await readSource(path);
    expect(source.bytes.byteLength).toBe(maxSourceBytes);
    expect(source.text.startsWith("\uFEFF// 中文\r\n")).toBe(true);
  });

  test("rejects 16,385 bytes with the actual size before any layout", async () => {
    const put = await fixture();
    const path = await put("big.cpp", new Uint8Array(maxSourceBytes + 1).fill(0x61));
    await expect(readSource(path)).rejects.toThrow(/16,385/);
    await expect(readSource(path)).rejects.toThrow(/16,384/);
  });

  test("reports the real size of a larger file instead of the read-ahead cap", async () => {
    const put = await fixture();
    const path = await put("big.cpp", new Uint8Array(90_000).fill(0x61));
    await expect(readSource(path)).rejects.toThrow(/90,000/);
    await expect(readSource(path)).rejects.toThrow(/16,384/);
  });

  test("reports the real size of a 20,000-byte file", async () => {
    const put = await fixture();
    const path = await put("big.cpp", new Uint8Array(20_000).fill(0x61));
    await expect(readSource(path)).rejects.toThrow(/20,000/);
  });

  test("rejects invalid UTF-8 and NUL bytes", async () => {
    const put = await fixture();
    const bad = await put("bad.txt", Uint8Array.from([0x63, 0x28, 0xc3, 0x28]));
    await expect(readSource(bad)).rejects.toThrow(/UTF-8/);
    const nul = await put("nul.txt", Uint8Array.from([0x61, 0x00, 0x62]));
    await expect(readSource(nul)).rejects.toThrow(/UTF-8/);
  });

  test("returns the filename alongside the snapshot", async () => {
    const put = await fixture();
    const path = await put("A.cpp", "int main(){}\n");
    const source = await readSource(path);
    expect(source.filename).toBe("A.cpp");
    expect(source.text).toBe("int main(){}\n");
  });
});
