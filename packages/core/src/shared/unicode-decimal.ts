// 由 scripts/generate-tool-unicode.py 生成；不要手工修改数字表。
// 来源：CPython 3.14 unicodedata.decimal，Unicode 16.0.0；760个数字/76个连续组。
// 不使用Node/ICU的Unicode属性；十进制转换仅处理Nd，isdigit保留Python的独立判定语义。
const decimalStarts: readonly number[] = Object.freeze([
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6,
  0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0,
  0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80,
  0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900,
  0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40,
  0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
  0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50,
  0x11d50, 0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70,
  0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0,
  0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
])

/** Unicode16 Nd精确字符类；组合RegExp时须使用u标志。 */
export const decimalDigitPattern = "[\\u{30}-\\u{39}\\u{660}-\\u{669}\\u{6f0}-\\u{6f9}\\u{7c0}-\\u{7c9}\\u{966}-\\u{96f}\\u{9e6}-\\u{9ef}\\u{a66}-\\u{a6f}\\u{ae6}-\\u{aef}\\u{b66}-\\u{b6f}\\u{be6}-\\u{bef}\\u{c66}-\\u{c6f}\\u{ce6}-\\u{cef}\\u{d66}-\\u{d6f}\\u{de6}-\\u{def}\\u{e50}-\\u{e59}\\u{ed0}-\\u{ed9}\\u{f20}-\\u{f29}\\u{1040}-\\u{1049}\\u{1090}-\\u{1099}\\u{17e0}-\\u{17e9}\\u{1810}-\\u{1819}\\u{1946}-\\u{194f}\\u{19d0}-\\u{19d9}\\u{1a80}-\\u{1a89}\\u{1a90}-\\u{1a99}\\u{1b50}-\\u{1b59}\\u{1bb0}-\\u{1bb9}\\u{1c40}-\\u{1c49}\\u{1c50}-\\u{1c59}\\u{a620}-\\u{a629}\\u{a8d0}-\\u{a8d9}\\u{a900}-\\u{a909}\\u{a9d0}-\\u{a9d9}\\u{a9f0}-\\u{a9f9}\\u{aa50}-\\u{aa59}\\u{abf0}-\\u{abf9}\\u{ff10}-\\u{ff19}\\u{104a0}-\\u{104a9}\\u{10d30}-\\u{10d39}\\u{10d40}-\\u{10d49}\\u{11066}-\\u{1106f}\\u{110f0}-\\u{110f9}\\u{11136}-\\u{1113f}\\u{111d0}-\\u{111d9}\\u{112f0}-\\u{112f9}\\u{11450}-\\u{11459}\\u{114d0}-\\u{114d9}\\u{11650}-\\u{11659}\\u{116c0}-\\u{116c9}\\u{116d0}-\\u{116d9}\\u{116da}-\\u{116e3}\\u{11730}-\\u{11739}\\u{118e0}-\\u{118e9}\\u{11950}-\\u{11959}\\u{11bf0}-\\u{11bf9}\\u{11c50}-\\u{11c59}\\u{11d50}-\\u{11d59}\\u{11da0}-\\u{11da9}\\u{11f50}-\\u{11f59}\\u{16130}-\\u{16139}\\u{16a60}-\\u{16a69}\\u{16ac0}-\\u{16ac9}\\u{16b50}-\\u{16b59}\\u{16d70}-\\u{16d79}\\u{1ccf0}-\\u{1ccf9}\\u{1d7ce}-\\u{1d7d7}\\u{1d7d8}-\\u{1d7e1}\\u{1d7e2}-\\u{1d7eb}\\u{1d7ec}-\\u{1d7f5}\\u{1d7f6}-\\u{1d7ff}\\u{1e140}-\\u{1e149}\\u{1e2f0}-\\u{1e2f9}\\u{1e4f0}-\\u{1e4f9}\\u{1e5f1}-\\u{1e5fa}\\u{1e950}-\\u{1e959}\\u{1fbf0}-\\u{1fbf9}]"

// Python isdigit额外接受的128个非十进制字符；不将它们转换成十进制ID。
const extraDigit = new RegExp("^[\\u{b2}-\\u{b3}\\u{b9}\\u{1369}-\\u{1371}\\u{19da}\\u{2070}\\u{2074}-\\u{2079}\\u{2080}-\\u{2089}\\u{2460}-\\u{2468}\\u{2474}-\\u{247c}\\u{2488}-\\u{2490}\\u{24ea}\\u{24f5}-\\u{24fd}\\u{24ff}\\u{2776}-\\u{277e}\\u{2780}-\\u{2788}\\u{278a}-\\u{2792}\\u{10a40}-\\u{10a43}\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}]$", 'u')

function decimalValue(codepoint: number): number {
  let left = 0, right = decimalStarts.length - 1
  while (left <= right) {
    const middle = (left + right) >>> 1, start = decimalStarts[middle]!
    if (codepoint < start) right = middle - 1
    else if (codepoint > start + 9) left = middle + 1
    else return codepoint - start
  }
  return -1
}

/** 严格判定非空整段十进制数字；不接受符号、空白或更高Unicode版本新增数字。 */
export function isDecimalDigits(token: string): boolean {
  if (!token) return false
  for (const character of token) if (decimalValue(character.codePointAt(0)!) < 0) return false
  return true
}

/** 对齐Python str.isdigit的非空整段判定；不代表后续int转换一定成功。 */
export function isDigitString(token: string): boolean {
  if (!token) return false
  for (const character of token)
    if (decimalValue(character.codePointAt(0)!) < 0 && !extraDigit.test(character)) return false
  return true
}

/** 固定Unicode16逐码点转值；未映射字符原样保留，调用方仍须验证整段输入。 */
export function asciiDecimalDigits(token: string): string {
  return Array.from(token, character => {
    const value = decimalValue(character.codePointAt(0)!)
    return value < 0 ? character : String(value)
  }).join('')
}
