import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { readFile, stat } from "node:fs/promises";

export interface PrintConfig {
  printer?: string;
  color?: "monochrome" | "color";
  team?: string;
  contest?: string;
  location?: string;
}

const stringFields = ["printer", "team", "contest", "location"] as const;

type Environment = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// The whole environment is read here so a caller (or test) that passes an
// isolated environment cannot fall back to the developer's real configuration.
export function userConfigPath(env: Environment = process.env) {
  const home = env.HOME ?? homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "xprint", "config.yaml");
  if (platform() === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "xprint", "config.yaml");
  // XDG_CONFIG_HOME must be an absolute path; a relative one is ignored by the spec.
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "xprint", "config.yaml");
}

// A missing file is an optional layer, but a directory, a permission error or
// anything else must surface instead of silently disabling the layer.
async function optionalFile(path: string): Promise<boolean> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    if (error.code === "ENOTDIR") {
      throw new ConfigError(`配置文件「${path}」无法访问：它的上级路径不是目录。`);
    }
    throw error;
  });
  if (info === null) return false;
  if (!info.isFile()) throw new ConfigError(`配置文件「${path}」不是普通文件。`);
  return true;
}

async function findContestConfig(cwd: string) {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".xprint.yaml");
    if (await optionalFile(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function describeValue(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value === "object" ? "映射" : `「${String(value)}」`;
}

async function parseFile(path: string): Promise<PrintConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`无法读取配置文件「${path}」：${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    const parseError = error as Error & { linePos?: { line: number; col: number }[] };
    const line = parseError.linePos?.[0]?.line;
    const reason = (error as Error).message.split("\n")[0];
    throw new ConfigError(`配置文件「${path}」${line ? `第 ${line} 行` : ""}有误：${reason}`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError(`配置文件「${path}」有误：顶层必须是映射。`);
  }
  const source = data as Record<string, unknown>;
  const config: PrintConfig = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    if (key === "color") {
      if (value !== "monochrome" && value !== "color") {
        throw new ConfigError(`配置文件「${path}」有误：color 只能是 monochrome 或 color，当前为${describeValue(value)}。`);
      }
      config.color = value;
    } else if ((stringFields as readonly string[]).includes(key)) {
      if (typeof value !== "string") {
        throw new ConfigError(`配置文件「${path}」有误：${key} 必须是字符串，当前为${describeValue(value)}。`);
      }
      config[key as (typeof stringFields)[number]] = value;
    } else {
      throw new ConfigError(`配置文件「${path}」有误：未知字段「${key}」。`);
    }
  }
  return config;
}

export async function loadConfig(cwd: string, env: Environment = process.env): Promise<PrintConfig> {
  let merged: PrintConfig = {};
  const userPath = userConfigPath(env);
  if (await optionalFile(userPath)) merged = { ...merged, ...(await parseFile(userPath)) };
  const contestPath = await findContestConfig(cwd);
  if (contestPath) merged = { ...merged, ...(await parseFile(contestPath)) };
  if (env.XPRINT_CONFIG) {
    const override = isAbsolute(env.XPRINT_CONFIG) ? env.XPRINT_CONFIG : resolve(cwd, env.XPRINT_CONFIG);
    if (!(await optionalFile(override))) throw new ConfigError(`XPRINT_CONFIG 指向的文件不存在：${override}`);
    merged = { ...merged, ...(await parseFile(override)) };
  }
  return merged;
}
