# Windows 打印后端

xprint 的 Windows 发行包随附 SumatraPDF 3.6.1 便携版，用于把排版好的 PDF 交给系统打印队列。选手只运行 `xprint.exe`。

## 固定版本与校验

| 项目 | 值 |
| --- | --- |
| 版本 | 3.6.1（2026-04-06 发布） |
| 下载 | <https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip> |
| 压缩包 SHA256 | `98b33a518d42986856d225064b0cd2d3643ecf78cbf84ab873d26cc51877a544` |
| 可执行文件 SHA256 | `719f689b34f47be8ca105ce8484948474dafde0e106bab599e4a89326070c3d0` |
| Authenticode 签名者 | `CN=Krzysztof Kowalczyk`（Certum Code Signing 2021 CA） |
| 许可证 | GPL-3.0 |
| 对应源码 | <https://github.com/sumatrapdfreader/sumatrapdf/releases/tag/3.6.1rel> |

官网和 GitHub Release 都不发布校验和文件。以上 SHA256 由 xprint 项目从官网 HTTPS 下载后自行计算，用于固定版本后的漂移检测，并由 Authenticode 签名者交叉验证。`windows/fetch-sumatra.ps1` 在下载后同时校验压缩包哈希、可执行文件哈希和签名者。

## 无对话框提交

```
xprint.exe -y A.cpp
```

xprint 通过以下命令把 PDF 交给 spooler，全程不显示对话框。

```
SumatraPDF-3.6.1-64.exe -print-to "<队列名>" -silent -print-settings "paper=A4,1x,monochrome" <pdf>
```

SumatraPDF 3.6.1 只用退出码 0 表示已交给打印系统，非 0 表示失败。它不提供系统作业号，xprint 因此不显示作业号。spooler 或驱动之后的错误（缺纸、脱机、卡纸）无法回报，需要选手核对系统队列。

`-print-settings` 固定带 `1x`。SumatraPDF 只有在解析到 `<份数>x` 时才写入 `dmCopies` 并置 `DM_COPIES`，否则沿用驱动的默认份数，可能打出多份。

## 打包约束

发行包必须把 `SumatraPDF-3.6.1-64.exe` 与 `xprint.exe` 放在同一目录。xprint 用 `dirname(process.execPath)` 定位它，因为 Bun 编译后的 `import.meta.dir` 是虚拟的 `/$bunfs/root`，不指向磁盘上的真实文件。

枚举队列和读取默认队列通过 `powershell.exe -NoProfile -NonInteractive -Command` 执行固定脚本，脚本内容不随用户输入变化，配置中的队列名只在 Node 侧与枚举结果做精确比较。脚本开头显式设置 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，否则 Windows PowerShell 5.1 在 stdout 被重定向时会用系统代码页输出，中文队列名会损坏。

子进程的 stdout/stderr 先按字节收集，进程退出后整体按 UTF-8 解码，避免中文队列名被管道分块切开。PowerShell 和 SumatraPDF 以 `windowsHide` 启动，不弹出控制台窗口。找不到 `powershell.exe` 或随包的 SumatraPDF 时，错误信息会指出缺失的路径并提示检查安装或发行包是否完整。查询失败时错误信息带上 PowerShell 退出码与原始输出，并提示检查 Print Spooler 服务或在配置中显式指定 `printer`。

交给 SumatraPDF 的临时 PDF 以源文件名命名（例如 `A.cpp.pdf`），方便在系统队列中辨认作业。Windows 单个路径分量上限为 255 个 UTF-16 代码单元，过长的名字会截断后保留 `.pdf` 后缀；非法字符替换为 `_`，`CON`、`NUL` 等保留名加前缀 `_`。打印结束后临时目录尽力删除，删除失败只发出中文警告，不影响已经接受的作业结果。

## 验收脚本

`windows/acceptance.ps1` 在真实的 Windows 打印栈上跑 `xprint -y layout.cpp`。SumatraPDF 打印时把每页渲染成位图再交给驱动（`Print.cpp` 中 `RenderPage` 后 `RenderedBitmap::Blit`），所以 Print to PDF 的产物没有可提取文本，脚本不解析 PDF 内容，而是用标准工具核对：

1. `pdfinfo` 断言输出恰好 7 页。输入是 `tests/fixtures/layout.cpp` 的副本，末尾追加一行 ASCII 标记 `XPRINT-LAST-LINE-7Z7`，fixture 本身不变。
2. `pdftoppm` 把末页渲染成 200 dpi PNG，`tesseract -l eng --psm 6` 识别后断言包含该标记。
3. 首页另存 96 dpi PNG 作为证据，与虚拟队列收到的 PDF 一起保留在 `-WorkDir`。

脚本创建两个唯一命名的临时队列（名称含中文）和指向输出 PDF 的本地端口，把其中一个设为系统默认打印机并读回验证，再分别验证默认队列提交与显式中文队列提交。默认队列作业断言摘要为黑白；中文队列作业从题目子目录运行，队列名来自比赛根目录配置、`color: color` 来自子目录配置，断言摘要显示彩色并包含队列名。中文队列作业完成后再次核对默认队列的输出文件哈希，确认它未被后续作业改写。`finally` 里先恢复原默认打印机并读回，再只删除本次创建的队列与端口，并断言运行前的队列集合完整、默认打印机与运行前一致。恢复失败时保留临时队列，避免 Windows 静默换默认。脚本只在 `GITHUB_ACTIONS=true` 且 `RUNNER_ENVIRONMENT=github-hosted` 的 GitHub 托管 runner 上运行，因为它会临时改动系统默认打印机。

彩色断言检查的是摘要里的打印颜色请求。Microsoft Print to PDF 可能把页面渲染成灰度位图，因此脚本不从输出图像推断颜色模式；如需验证纸面颜色，应在支持彩色的实体打印机上进行。

CI 前置条件（这些都不是 xprint CLI 的依赖）：

| 项目 | 要求 |
| --- | --- |
| runner | `windows-2022`，自带 Microsoft Print to PDF 驱动与 Print Spooler |
| shell | `pwsh`；脚本以 UTF-8 BOM 保存，Windows PowerShell 5.1 也能正确读中文 |
| poppler | `pdfinfo`、`pdftoppm` 在 `PATH` 上 |
| tesseract | `tesseract` 在 `PATH` 上，带 `eng` 语言包 |

用法：

```console
> pwsh -File windows/acceptance.ps1 -Xprint dist/xprint.exe -WorkDir out/acceptance
```
