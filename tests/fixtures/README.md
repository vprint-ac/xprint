# 排版对照样例

两份 PDF 由固定版本的 Hydro 模板生成。生成基准时删除页码前的上游署名及分隔符，随后按整页像素对照。

## 来源

- 上游模板：hydro-dev/xcpc-tools 提交 `b4faf1f11adb9b1f92db6fbfc55d2de833264a3f` 的 `packages/server/client/typst.ts`
- 依赖：`@myriaddreamin/typst-ts-web-compiler` 0.6.1-rc5、`dejavu-fonts-ttf` 2.37.3、`@expo-google-fonts/noto-sans-sc` 0.4.3
- 固定时间：`1795761128000`，即 2026/11/27 14:32:08（Asia/Shanghai）
- 页眉：队伍 `校队`、座位 `007`

仓库不保存上游模板的副本。`render-reference.ts` 在运行时从上游检出目录读取原始 `typst.ts`，字体和 WASM 编译器则由本仓库 `bun.lock` 锁定的三个依赖提供。

## 重新生成

需要 `git`、Poppler 的 `pdftoppm` 和已按 `bun.lock` 安装好的依赖。在仓库根目录运行：

```console
$ git clone https://github.com/hydro-dev/xcpc-tools.git ../hydro-reference
$ git -C ../hydro-reference checkout --detach b4faf1f11adb9b1f92db6fbfc55d2de833264a3f
$ bun install --frozen-lockfile
$ bun tests/fixtures/render-reference.ts --upstream ../hydro-reference --out /tmp/xprint-fixtures
$ pdftoppm -r 96 -png tests/fixtures/hydro-layout-bw.pdf /tmp/xprint-fixtures/expected-layout
$ pdftoppm -r 96 -png /tmp/xprint-fixtures/hydro-layout-bw.pdf /tmp/xprint-fixtures/actual-layout
$ pdftoppm -r 96 -png tests/fixtures/hydro-long-lines-color.pdf /tmp/xprint-fixtures/expected-long
$ pdftoppm -r 96 -png /tmp/xprint-fixtures/hydro-long-lines-color.pdf /tmp/xprint-fixtures/actual-long
$ (cd /tmp/xprint-fixtures && shasum -a 256 expected-*.png | cut -d' ' -f1 | sort > expected.sha &&
>  shasum -a 256 actual-*.png | cut -d' ' -f1 | sort > actual.sha && diff expected.sha actual.sha && echo 逐页一致)
```

脚本会先核对上游 `HEAD` 等于上述提交，且 `typst.ts` 没有未提交的修改，否则直接退出。`layout.cpp` 排成 7 页黑白，`long-lines.cpp` 排成 1 页彩色，共 8 页。

要覆盖仓库里的基准，把 `--out` 指向 `tests/fixtures` 即可。

## 对照方式

`tests/layout.test.ts` 用同一台机器的 `pdftoppm -r 96 -png` 渲染两侧，逐页比较 SHA-256。参考 PDF 的 `CreationDate` 会随生成时刻变化，所以比较的是光栅像素，不是 PDF 字节。

## 已知边界

`long-lines.cpp` 里没有空格的超长 token 在上游 Hydro 中本身就会超出页边，Typst 的 `raw` 不会对它折行。xprint 按规格对齐上游，此处不额外处理。
