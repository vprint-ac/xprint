// generateTypst and BWTmTheme are adapted from Hydro/XCPC-TOOLS
// https://github.com/hydro-dev/xcpc-tools/blob/b4faf1f11adb9b1f92db6fbfc55d2de833264a3f/packages/server/client/typst.ts
// The upstream TypstCompilerDriver is forked from typst.ts (Apache-2.0):
// https://github.com/Myriad-Dreamin/typst.ts/blob/main/packages/typst.ts/src/compiler.mts
// xprint only reuses the document template and the black-and-white theme.
// Invisible metadata exposes the final page count. The input lives at "/source".
// xprint calls the WASM compiler directly in src/layout.ts and does not copy the driver.
// See THIRD_PARTY_LICENSES.md for the full license texts.

export function generateTypst(
  team: string,
  location: string,
  filename: string,
  originalFilename: string,
  lang: string,
  createAt: number,
  codeColor: boolean,
) {
  return `
#let fit(name: "", width: 100mm) = {
  context {
    if measure(text(name)).width < width {
      return name
    }
    for len in range(name.codepoints().len() - 1, 5, step: -1) {
      if measure(text(name
          .codepoints()
          .slice(0, len)
          .join() + " ...")).width < width {
        return name.codepoints().slice(0, len).join() + " ..."
      }
    }
    panic("Error")
  }
}

#let print(
  team: "",
  location: "",
  filename: "",
  original: "",
  lang: "",
) = {
  set document(author: (team), title: filename)
  set text(lang: "zh")
  set page(
    paper: "a4",
    header: [
      #if (location != "") {
        text(weight: "black", size: 10pt)[[#location] ]
      }
      #fit(name: team)
      #h(1fr)
      ${new Date(createAt).toLocaleString('zh')}
      #linebreak()
      filename: #original
      #h(1fr)
      By Hydro/XCPC-TOOLS | Page #context counter(page).display("1 of 1", both: true)
    ],
  )
  show raw.where(block: true): code => {
    show raw.line: it => {
      box(
        stack(
          dir: ltr,
          box(width: 0em, align(right, text(fill: gray)[#it.number])),
          h(1em),
          it.body,
        ),
      )
    }
    code
  }
  context [#metadata(counter(page).final().first())<xprint-page-count>]
  raw(read(filename), lang: lang, block: true${codeColor ? '' : ', theme: "/XCPCTOOLS/BW.tmtheme"'})
}
#print(
    team: ${JSON.stringify((team || '').replace(/🌟/g, '[STAR]'))},
    location: ${JSON.stringify(location || '')},
    filename: ${JSON.stringify(filename || '')},
    original: ${JSON.stringify(originalFilename || filename || '')},
    lang: ${JSON.stringify(lang || '')},
)
`;
}

export const BWTmTheme =
  '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>name</key><string>BW</string><key>settings</key><array><dict><key>settings</key><dict><key>background</key><string>#FFFFFF</string><key>caret</key><string>#525252</string><key>foreground</key><string>#333333</string><key>invisibles</key><string>#3B3A32</string><key>lineHighlight</key><string>#3E3D32</string><key>selection</key><string>#49483E</string></dict></dict><dict><key>name</key><string>Comment</string><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#999999</string></dict></dict><dict><key>name</key><string>String</string><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#4A4A4A</string></dict></dict><dict><key>name</key><string>Number</string><key>scope</key><string>constant.numeric</string><key>settings</key><dict><key>foreground</key><string>#4A4A4A</string></dict></dict><dict><key>name</key><string>Built-in constant</string><key>scope</key><string>constant.language</string><key>settings</key><dict><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>User-defined constant</string><key>scope</key><string>constant.character, constant.other</string><key>settings</key><dict><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Variable</string><key>scope</key><string>variable</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Keyword</string><key>scope</key><string>keyword</string><key>settings</key><dict><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold</string></dict></dict><dict><key>name</key><string>Storage</string><key>scope</key><string>storage</string><key>settings</key><dict><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold</string></dict></dict><dict><key>name</key><string>Storage type</string><key>scope</key><string>storage.type</string><key>settings</key><dict><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold </string></dict></dict><dict><key>name</key><string>Class name</string><key>scope</key><string>entity.name.class</string><key>settings</key><dict><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Inherited class</string><key>scope</key><string>entity.other.inherited-class</string><key>settings</key><dict><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Function name</string><key>scope</key><string>entity.name.function</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Function argument</string><key>scope</key><string>variable.parameter</string><key>settings</key><dict><key>fontStyle</key><string>italic</string><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Tag name</string><key>scope</key><string>entity.name.tag</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#F92672</string></dict></dict><dict><key>name</key><string>Tag attribute</string><key>scope</key><string>entity.other.attribute-name</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#A6E22E</string></dict></dict><dict><key>name</key><string>Library function</string><key>scope</key><string>support.function</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold</string></dict></dict><dict><key>name</key><string>Library constant</string><key>scope</key><string>support.constant</string><key>settings</key><dict><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold</string></dict></dict><dict><key>name</key><string>Library class&#x2f;type</string><key>scope</key><string>support.type, support.class</string><key>settings</key><dict><key>foreground</key><string>#000000</string><key>fontStyle</key><string> bold</string></dict></dict><dict><key>name</key><string>Library variable</string><key>scope</key><string>support.other.variable</string><key>settings</key><dict><key>fontStyle</key><string></string><key>foreground</key><string>#000000</string></dict></dict><dict><key>name</key><string>Invalid</string><key>scope</key><string>invalid</string><key>settings</key><dict><key>background</key><string>#F92672</string><key>fontStyle</key><string></string><key>foreground</key><string>#F8F8F0</string></dict></dict><dict><key>name</key><string>Invalid deprecated</string><key>scope</key><string>invalid.deprecated</string><key>settings</key><dict><key>background</key><string>#AE81FF</string><key>foreground</key><string>#F8F8F0</string></dict></dict></array><key>uuid</key><string>D8D5E82E-3D5B-46B5-B38E-8C841C21347D</string><key>colorSpaceName</key><string>sRGB</string><key>semanticClass</key><string>theme.light.bw</string><key>author</key><string>J. Neugebauer</string><key>comment</key><string>Pure black and white Theme for printing.</string></dict></plist>';
