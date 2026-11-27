# 发行与验收

本文记录三平台发行包的构建、自动化验收和实体打印机验收。自动化通过只证明**系统打印队列已接单**；实际出纸需要按[实体 USB 验收](#实体-usb-验收)单独留证。

## 构建发行包

`scripts/package.py` 只依赖 Python 3 标准库，可在任何开发机为三个目标打包。未传 `--binary` 时调用 Bun 1.4.5 以 `--compile` 构建，并关闭 `.env` 和 `bunfig.toml` 自动加载。

```sh
python3 scripts/package.py --target linux-x64
python3 scripts/package.py --target macos-arm64
python3 scripts/package.py --target windows-x64 --sumatra dist/sumatra/SumatraPDF-3.6.1-64.exe
python3 scripts/package.py --target all --sumatra <已验证的 SumatraPDF 可执行文件>
```

已经交叉编译好的程序可以跳过构建：

```sh
python3 scripts/package.py --target linux-x64 --binary dist/xprint-linux-x64
```

Windows 发行包必须提供 `windows/sumatra.json` 中固定的 SumatraPDF 3.6.1 便携版。打包前会核对其 SHA256，不匹配即退出。获取并验证方法：

```powershell
pwsh ./windows/fetch-sumatra.ps1 -Destination dist/sumatra
```

输出在 `dist/release/`：

| 文件 | 内容 |
| --- | --- |
| `xprint-<版本>-<目标>.zip` | 单一顶层目录 `xprint-<版本>-<目标>/` |
| `xprint-<版本>-<目标>.zip.sha256` | 该压缩包的 SHA256 |
| `SHA256SUMS` | 目录内全部压缩包的校验和 |

压缩包内含可执行文件、`README.md`、`LICENSE`、`DESIGN.md`、`GLOSSARY.md`、`docs/acceptance.md`、`THIRD_PARTY_LICENSES.md` 和整个 `licenses/`。`LICENSE` 缺失时打包直接失败。Windows 包另含 `SumatraPDF-3.6.1-64.exe`、`windows/README.md`、`windows/sumatra.json` 和 `windows/fetch-sumatra.ps1`。条目顺序和时间戳固定，相同输入重复打包得到字节相同的压缩包。

## GitHub Actions

`.github/workflows/release.yml` 在 `linux-x64`、`macos-arm64`、`windows-x64` 三个原生 runner 上分别执行：

1. 安装 Bun 1.4.5 和原生测试依赖（Poppler；Windows 另需 Tesseract）。
2. Linux 和 macOS 运行 `bun run check`、`bun test` 和打包测试。`bun test` 用 `#!/bin/sh` 伪造 `lp`/`lpstat` 并依赖 Python 的 `pty`，因此 Windows 只运行 `bun run check` 和打包测试。
3. 用 `scripts/package.py` 打包，Windows 先用 `windows/fetch-sumatra.ps1` 下载并验证 SumatraPDF。
4. 用 Python `hashlib` 核对压缩包的 `SHA256SUMS` 条目和 `.zip.sha256` 后上传 `xprint-<目标>` 构件。
5. 在独立的 **playback** 作业里重新下载该构件、再次核对校验和，解压后运行验收脚本。构建目录中的程序不参与 playback。Windows 在运行 `windows/acceptance.ps1` 前先确认 Print Spooler 已启动、Microsoft Print to PDF 驱动存在，缺少时输出 runner 上的服务与驱动列表作为诊断。

playback 的隔离方式：

| 平台 | 隔离 | 验收脚本 |
| --- | --- | --- |
| Linux | `docker run --network none`，容器内启动 dbus、Avahi、cupsd 和回环 IPP 打印机；CLI 以 `nobody` 运行，PATH 只有 `/usr/bin:/bin` | `scripts/release/linux-accept.py` |
| macOS | `/usr/bin/sandbox-exec` 拒绝非回环出站流量，保留 localhost CUPS | `scripts/release/macos-accept.py` |
| Windows | 仅为 `xprint.exe` 和 `SumatraPDF-3.6.1-64.exe` 添加出站阻止规则，`finally` 中删除 | `windows/acceptance.ps1` |

Unix 脚本的共用逻辑在 `scripts/release/acceptance_common.py`。两个平台都从比赛目录的题目子目录运行 `xprint -y A.cpp`，分别以黑白和彩色打印 `tests/fixtures/layout.cpp`，并检查：

- 回执包含队列名和页数，系统作业号存在。
- `ipptool -tv ipp://localhost/jobs/<数字作业号> get-job-attributes.test` 返回 `copies = 1` 和与配置一致的 `print-color-mode`。
- 接单 PDF 共 7 页，每页含 `[007] 校队` 和 `filename: A.cpp`，各出现一次 `Page 1 of 7`、`Page 7 of 7`、`line 359` 和末行 `return 0; // 最后一行`。回环 IPP 打印机把页按新到旧写入 spool，因此检查针对整份文档而非固定物理页序。
- 黑白打印件的光栅没有任何彩色像素；彩色打印件在首末页有彩色像素。
- 非交互环境缺少 `-y` 时退出非零且不产生新作业。
- 包内存在 `LICENSE`、`README.md`、`THIRD_PARTY_LICENSES.md` 和非空 `licenses/`。

Windows 由 `windows/acceptance.ps1` 使用 Microsoft Print to PDF 建立临时默认队列和中文名队列，校验 SumatraPDF 的 SHA256 与 Authenticode 签名，核对页数和末页，并在结束时恢复原默认打印机、删除临时队列。

推送 `v*` 标签后，`publish` 作业在三个平台 playback 全部通过后把三个 `xprint-<目标>` 构件分别下载到独立目录（`-evidence` 构件不匹配下载模式），逐个用其 `.zip.sha256` 和该平台原始 `SHA256SUMS` 核对，三平台齐全且无重复后才写出合并的 `SHA256SUMS`，再把同一批压缩包附到 GitHub Release。未打标签时不会发布。

## 手工离线验收

自动化之外，每个平台按以下步骤从普通用户环境复核。先下载并校验，再断开外网，确认未安装 Bun 和 Typst（`bun --version`、`typst --version` 均应失败）。

1. 联网时下载本平台的 `xprint-<版本>-<目标>.zip` 和它的 `.zip.sha256`（或 `SHA256SUMS`）。只校验自己这一个压缩包：`shasum -a 256 -c xprint-<版本>-<目标>.zip.sha256`（Linux 用 `sha256sum -c`，Windows 用 `Get-FileHash`）。若下载的是 `SHA256SUMS`，只取对应那一行：`grep ' xprint-<版本>-<目标>.zip$' SHA256SUMS | shasum -a 256 -c -`；完整清单包含三个平台，直接 `-c SHA256SUMS` 会因缺少其他两个压缩包而失败。校验通过后再断网。
2. 解压到普通用户可写目录。Windows 需保留 `xprint.exe` 与 `SumatraPDF-3.6.1-64.exe` 在同一目录。
3. 确认系统已添加 USB 打印机队列，并在用户配置中写好队列名。
4. 在比赛目录写 `.xprint.yaml`，进入题目子目录，放入 `A.cpp`，用解压目录中 `xprint` 的绝对路径运行（例如 `/path/to/xprint-<版本>-<目标>/xprint A.cpp`，Windows 为 `C:\path\to\xprint-<版本>-<目标>\xprint.exe A.cpp`），或先把该目录加入 `PATH` 再执行 `xprint A.cpp`。核对摘要中的队列、颜色、比赛、文件名、字节数和修改时间后按回车。
5. 用 `N` 和 Ctrl+C 各取消一次，确认队列没有新作业。再以第 4 步同样的方式加上 `-y` 提交，核对回执页数和作业号，在系统打印队列查看接单。
6. 打开 `THIRD_PARTY_LICENSES.md` 和 `licenses/`，确认许可证全文与来源链接齐全。

记录发行包文件名和 SHA256、系统版本、队列名、作业号、PDF 页数。此记录只代表队列接单。

## 实体 USB 验收

下表每一行都需要实际设备和实际纸张。自动化结果不能填入「出纸」列；没有设备的项目保持「待验」。

| 平台 | 发行包 / SHA256 | 设备与驱动 | 系统队列接单 | 出纸 | 份数 | 页眉（队名、座位、时间、页码） | 末行 | 黑白模式 | 彩色模式 | 证据与日期 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux x64 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验（需彩色设备） | 待验 |
| macOS arm64 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验（需彩色设备） | 待验 |
| Windows x64 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验 | 待验（需彩色设备） | 待验 |

设备不支持彩色时，在「彩色模式」记录「不适用（设备仅黑白）」，不要记为通过。以上所有实机项目当前均为**待验**，本次交付没有产生任何纸张输出。
