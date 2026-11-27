# xprint

在 ICPC / CCPC 模拟赛中，从终端把一个源码文件打印到本机打印机。打印件使用 A4 单栏排版，每页都有语法高亮、行号、原文件名、打印时间和页码。安装好打印机驱动后即可离线使用。

## 打印

构建目标为 Linux x64、macOS arm64 和 Windows x64。正式版本的 ZIP 和 SHA-256 校验文件会发布到 [GitHub Releases](https://github.com/vprint-ac/xprint/releases)。

将系统中已经添加的 USB 打印机设为默认队列，解压对应平台的发行包。把程序所在目录加入 PATH 后，在比赛目录运行：

```sh
xprint A.cpp
```

也可以用程序的完整路径从比赛目录打印，例如 `~/tools/xprint A.cpp`。Windows 发行包中的打印组件应和程序一起保留。

核对终端显示的队列、颜色和文件信息。回车或按 Y 提交一份，N 取消，Ctrl+C 中断。编辑器快捷键或脚本可以使用 `xprint -y A.cpp` 或 `xprint A.cpp --yes`，两种写法都会先显示摘要。成功后可到系统打印队列查看作业。

每次接受一个不超过 **16 KiB（16,384 字节）** 的 UTF-8 普通文本文件。文件大小包含 BOM 和换行，页数不限。未识别扩展名的文件按纯文本排版。和 Hydro 原版一样，没有断点的超长字符串可能超出右页边。

## 选择打印机、颜色和比赛

默认使用系统默认队列和黑白高亮。把常用设置写入用户配置：

```yaml
printer: HP_LaserJet  # 操作系统显示的队列名
color: monochrome     # 彩色用 color
```

| 平台 | 用户配置 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/xprint/config.yaml`，默认 `~/.config/xprint/config.yaml` |
| macOS | `~/Library/Application Support/xprint/config.yaml` |
| Windows | `%LOCALAPPDATA%\xprint\config.yaml` |

本场训练的设置写在比赛目录的 `.xprint.yaml`。从题目子目录运行时，xprint 向上查找最近的一份：

```yaml
team: 校队
contest: 周六训练
location: "007"
color: color
```

临时覆盖时，将环境变量 `XPRINT_CONFIG` 设为另一份 YAML 的路径。三层配置按字段覆盖，优先级从高到低为环境变量指定的文件、最近的比赛配置、用户配置。上例会沿用用户设置的打印机。相对路径从执行命令的目录解析。

## 构建与验证

使用 Bun 1.4.5。开发机上的 PDF 文本和版式测试会调用 Poppler 命令行工具。

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

交互与打印件版式的来源见[设计稿](DESIGN.md)，项目用语见[术语表](GLOSSARY.md)。[发行包验收](docs/acceptance.md)记录了三平台的复验步骤；第三方组件见[许可证清单](THIRD_PARTY_LICENSES.md)。
