import { Command } from "commander";
import { isCancel } from "@clack/prompts";
import manifest from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { PrintBackendError, resolveQueue, submitPdf } from "./printer.ts";
import { layoutPrintout } from "./layout.ts";
import { readSource } from "./source.ts";
import { confirmPrint, formatFileAge, interactive, localTime, report, terminalLabel } from "./terminal.ts";

async function printFile(path: string, yes: boolean) {
  const config = await loadConfig(process.cwd());
  const file = await readSource(path).catch(error => {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到文件。" : (error as Error).message;
    throw new Error(`${terminalLabel(path)} 读取失败：${terminalLabel(reason)}`);
  });
  const queue = await resolveQueue(config.printer);
  const color = config.color === "color";
  const now = Date.now();
  report("info", [
    config.contest ? `当前比赛　${terminalLabel(config.contest)}` : null,
    `打印机　　${terminalLabel(queue)}（${color ? "彩色" : "黑白"}）`,
    `当前时间　${localTime(now)}`,
    `文件名　　${terminalLabel(file.filename)}`,
    `文件大小　${file.bytes.byteLength.toLocaleString("en-US")} 字节`,
    `上次修改　${localTime(file.mtime)}（${formatFileAge(now - file.mtime.getTime())}）`,
  ].filter(Boolean).join("\n"));
  if (!yes) {
    if (!interactive) throw new Error("非交互模式需要 -y 或 --yes 确认打印。");
    const answer = await confirmPrint();
    if (answer !== "y") {
      report("info", "已取消打印。");
      if (isCancel(answer)) process.exitCode = 130;
      return;
    }
  }
  // Layout always uses the snapshot read before the prompt, so a later save
  // cannot change what the summary described.
  const { pdf, pageCount } = await layoutPrintout({
    filename: file.filename,
    text: file.text,
    printedAt: new Date(now),
    color,
    team: config.team,
    seat: config.location,
  });
  try {
    const result = await submitPdf({ queue, pdf, color, title: file.filename });
    report("success", `${terminalLabel(file.filename)} 已提交到 ${terminalLabel(queue)}，共 ${pageCount} 页${result.jobId ? `，作业号 ${result.jobId}` : ""}。`);
  } catch (error) {
    if (error instanceof PrintBackendError && error.uncertain) {
      throw new Error(`提交结果不明，请核对系统队列 ${terminalLabel(queue)} 后决定是否重打。${error.message}`);
    }
    throw error;
  }
}

const cli = new Command("xprint")
  .usage("[选项] [文件]")
  .description("将一份 UTF-8 源码排版后提交到本机打印机。")
  .version(manifest.version, "-V, --version", "显示版本")
  .configureHelp({
    styleSubcommandTerm: term => term.replace("[options]", "[选项]"),
    styleTitle: title => ({ "Usage:": "用法", "Arguments:": "参数", "Options:": "选项", "Commands:": "命令" })[title] ?? title,
  })
  .helpOption("-h, --help", "显示帮助")
  .helpCommand(false)
  .enablePositionalOptions()
  .option("-y, --yes", "显示打印信息后直接提交")
  .argument("[文件...]", "要打印的一个 UTF-8 文本文件")
  .action(async (files: string[], options: { yes?: boolean }) => {
    const [file, ...extra] = files;
    if (file === undefined) {
      if (process.argv.length > 2) throw new Error("请指定要打印的文件。");
      cli.outputHelp();
      return;
    }
    if (extra.length > 0) throw new Error(`一次只能打印一个文件，当前收到 ${files.length} 个：${files.map(terminalLabel).join("、")}。`);
    await printFile(file, Boolean(options.yes));
  });

async function main(args: string[]) {
  await cli.parseAsync(args, { from: "user" });
}

main(process.argv.slice(2)).catch(error => {
  report("error", error instanceof Error ? error.message : "xprint 运行失败。");
  process.exitCode = 1;
});
