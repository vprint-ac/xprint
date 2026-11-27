# 第三方组件与许可证

xprint 的发行物内嵌以下组件。许可证全文见 `licenses/` 目录。

| 组件 | 版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `@myriaddreamin/typst-ts-web-compiler` | 0.6.1-rc5 | [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) | Apache-2.0 | 内嵌 Typst 编译器 WASM，生成 PDF |
| `dejavu-fonts-ttf` | 2.37.3 | [dejavu-fonts](https://dejavu-fonts.github.io/) | Bitstream Vera、Arev，DejaVu 的修改归公有领域 | 代码等宽字体 |
| `@expo-google-fonts/noto-sans-sc` | 0.4.3 | [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) | MIT（Expo 封装）及 OFL-1.1（字体） | 中文注释与页眉字体 |
| Hydro/XCPC-TOOLS 打印流程 | 提交 `b4faf1f` | [hydro-dev/xcpc-tools](https://github.com/hydro-dev/xcpc-tools/blob/b4faf1f11adb9b1f92db6fbfc55d2de833264a3f/packages/server/client/typst.ts) | AGPL-3.0 | A4 页眉、行号、黑白主题及不可见字符的纸面表示 |
| SumatraPDF 便携版 | 3.6.1 | [sumatrapdfreader.org](https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip) | GPL-3.0 | Windows 发行包内把排版 PDF 交给系统打印队列 |

独立可执行文件使用 [Bun 1.4.5](https://github.com/oven-sh/bun/tree/bun-v1.4.5) 打包，运行时许可及第三方声明见 `licenses/bun-LICENSE.md`。随包的 [Commander](https://github.com/tj/commander.js)、[Clack](https://github.com/bombshell-dev/clack)、[yaml](https://github.com/eemeli/yaml) 及其 JavaScript 依赖的许可见 `licenses/cli-dependencies.txt`。

## Windows 便携组件

SumatraPDF 3.6.1 仅随 Windows x64 发行包分发，压缩包内只有一个可执行文件，与 xprint.exe 一起解压使用。版本、下载地址、项目自行固定的 SHA256、Authenticode 签名者与对应源码 tag 见 [windows/README.md](windows/README.md)。GPL-3.0 全文见 `licenses/sumatrapdf-GPL-3.0.txt`，对应源码为 GitHub tag [`3.6.1rel`](https://github.com/sumatrapdfreader/sumatrapdf/releases/tag/3.6.1rel)。

## 说明

- `src/hydro-template.ts` 改编自 Hydro/XCPC-TOOLS 的 `generateTypst` 与 `BWTmTheme`，保留上游出处注释。上游仓库整体采用 AGPL-3.0，直接分发该文件或其二进制派生物时须遵守 AGPL-3.0 的相应条款。
- 源码中的不可见字符沿用同一提交的 [printer.ts 中的 escapeText](https://github.com/hydro-dev/xcpc-tools/blob/b4faf1f11adb9b1f92db6fbfc55d2de833264a3f/packages/server/client/printer.ts#L65-L82) 显示方式。
- SumatraPDF 以 GPL-3.0 分发，xprint 通过命令行调用它，不链接其代码。重新分发 Windows 发行包时须同时提供许可证全文与对应源码获取方式。
- Typst 编译器驱动 `TypstCompilerDriver` 的上游实现在 typst.ts 中采用 Apache-2.0，xprint 在 `src/layout.ts` 中自行调用 WASM 接口，未复制该类。
- 字体许可证要求随发行物保留版权声明与许可文本，以上文件均已包含。
