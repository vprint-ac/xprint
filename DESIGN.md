# xprint 本地比赛打印设计稿

## 产品约定

选手在 VP 比赛目录下运行 `xprint A.cpp`，确认文件后，连接到本机的打印机输出一份带语法高亮的源码。Linux、macOS、Windows 都是首版目标。终端参考 VPrint，纸面参考 Hydro/XCPC-TOOLS。打印全程可离线完成。

打印机和黑白／彩色模式支持用户、比赛、环境变量三级设置。源码按文件大小限制，符合限制的文件打印全文。

## 终端交互

沿用 VPrint 的 Commander 帮助、Clack 信息样式和单键确认。以下是拟定的交互样例。

```console
$ xprint A.cpp
●  当前比赛　校队 / 周六训练
   打印机　　HP_LaserJet（黑白）
   当前时间　2026/11/27 14:32:08
   文件名　　A.cpp
   文件大小　3,214 字节
   上次修改　2026/11/27 14:31:41（27 秒前）
●  确认打印？ [Y/n]
✔  A.cpp 已提交到 HP_LaserJet，共 2 页。
```

一次接受一个 UTF-8 普通文本文件。建议将上限定为 16 KiB，即 16,384 个原始字节，包含 BOM 和换行。在确认前读取并校验文件，排版使用刚才读到的同一份内容。超过上限时显示实际字节数和上限。

交互终端回车或按 Y 提交，按 N 取消，Ctrl+C 中断并返回 130。`xprint -y A.cpp` 和 `xprint A.cpp --yes` 都显示相同摘要并直接提交。非交互或 CI 环境缺少 `-y` 时提示用法并返回非零。无参数显示中文帮助。未配置比赛名称时省略该行。配置指定的打印机不存在时显示队列名并退出，避免打到另一台设备。

成功提示表示打印后端已接受作业。能取得系统作业号时一并显示。提交结果不明时提示核对系统队列，由选手决定是否重打。

参考 [VPrint 打印流程](https://github.com/vprint-ac/VPrint/blob/1f857e1f99a8e6a83cf4f1911afc25435db44594/cli/src/printing.ts#L103) 和 [终端样式与按键](https://github.com/vprint-ac/VPrint/blob/1f857e1f99a8e6a83cf4f1911afc25435db44594/cli/src/terminal.ts)。

## 三级配置草案

配置使用 YAML。每层只写想设置的字段，省略的字段从低优先级继承。默认使用系统默认打印机和黑白模式，队伍、比赛和座位均可省略。

| 优先级 | 来源 | 读取方式 |
| --- | --- | --- |
| 1 | 用户配置 | Linux 用 `$XDG_CONFIG_HOME/xprint/config.yaml`，未设 XDG 时用 `~/.config/xprint/config.yaml`。macOS 用 `~/Library/Application Support/xprint/config.yaml`。Windows 用 `%LOCALAPPDATA%\xprint\config.yaml`。 |
| 2 | 比赛配置 | 从执行命令的当前目录向上查找，读取最近的一份 `.xprint.yaml`。在比赛的题目子目录中运行也会生效。 |
| 3 | 环境变量 | 建议用一个 `XPRINT_CONFIG` 指向覆盖用的 YAML 文件。相对路径从执行命令的目录解析。 |

例如，用户在 `config.yaml` 中写好平时使用的打印机和模式。

```yaml
printer: HP_LaserJet  # 系统中的打印队列名
color: monochrome     # 黑白
```

比赛目录的 `.xprint.yaml` 可以只改一行颜色设置，也可以加上本场训练的信息。

```yaml
color: color          # 本场彩打，打印机沿用用户配置
team: 校队
contest: 周六训练
location: "007"       # 带前导零的座位号用引号保留原样
```

这场训练使用 HP_LaserJet 彩色打印。若环境变量指向的文件仅含一行 `color: monochrome`，就恢复黑白，队名和打印机继续生效。缺少用户或比赛配置时使用已有层级。YAML 语法有误时，提示文件路径、行号和原因；环境变量指向的文件不存在时，提示相应路径并退出。

## 排版与本地打印

建议采用 TypeScript 和 Bun，复用与上游版本匹配的 Typst WASM、模板、黑白主题及字体，在发行物内提供所需资源。按扩展名选择语言，未知扩展名按纯文本排版。每页使用上游 A4 单栏、灰色行号及两行页眉。纸上保留原文件名、本次打印时间、署名和页码。队伍和座位取自合并配置，一次打印的所有页使用同一时间。彩色和黑白设置同时作用于语法主题和打印作业的颜色请求；实体设备需具备对应能力。

Linux 和 macOS 使用系统 CUPS 队列提交 PDF。Windows 建议在发行包内附带 SumatraPDF 便携版，通过其命令行指定队列和颜色；选手只运行 `xprint.exe`。目标初始构建矩阵参考 VPrint 的 Linux x64、macOS arm64、Windows x64。直接复用上游代码和分发第三方组件时，发行包随附相应许可证与来源说明。

参考 [Hydro 排版模板](https://github.com/hydro-dev/xcpc-tools/blob/b4faf1f11adb9b1f92db6fbfc55d2de833264a3f/packages/server/client/typst.ts)、[VPrint 三平台构建流程](https://github.com/vprint-ac/VPrint/blob/1f857e1f99a8e6a83cf4f1911afc25435db44594/.github/workflows/cli.yml)、[Bun 独立程序与内嵌资源](https://bun.com/docs/bundler/executables)、[CUPS 打印选项](https://openprinting.github.io/cups/doc/options.html) 和 [SumatraPDF 命令行](https://www.sumatrapdfreader.org/docs/Command-line-arguments)。

## 验收

1. 三个平台分别下载对应发行包，在未安装 Bun 或 Typst 的环境中断网运行。使用同一份含中文注释、长行和跨页代码的输入，与相同元信息下的上游 PDF 逐页比对。
2. 从题目子目录打印，验证三级逐字段覆盖、无比赛配置、最近比赛配置损坏、环境变量路径无效和指定队列不存在等情况。摘要中的目标、主题和实际提交选项应一致。
3. 在真实终端和重定向环境分别验证回车、Y、N、Ctrl+C、前后置 `--yes` 和缺少确认。取消和输入错误均产生零个打印作业。
4. 验证 16,384 字节可提交、16,385 字节被拒绝，并用小于上限且超过五页的源码确认最后一页完整输出。
5. 各系统先核对队列接单，再以 USB 打印机核对实际纸张、份数、页眉和末行。在支持彩色的设备上分别核对两种模式。单独记录各平台的发行包、队列和实机验收结果。
