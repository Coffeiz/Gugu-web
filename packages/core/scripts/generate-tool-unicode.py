"""用生产 Python 3.14 / Unicode 16 重建十进制数字和 isdigit 判定表。"""

import argparse
import json
from pathlib import Path
import unicodedata


def character_class(codepoints: list[int]) -> str:
    ranges: list[tuple[int, int]] = []
    for codepoint in codepoints:
        if ranges and codepoint == ranges[-1][1] + 1:
            ranges[-1] = ranges[-1][0], codepoint
        else:
            ranges.append((codepoint, codepoint))
    def escaped(codepoint: int) -> str:
        return "\\u{" + format(codepoint, "x") + "}"
    return "[" + "".join(escaped(start) if start == end else escaped(start) + "-" + escaped(end)
                         for start, end in ranges) + "]"


def generated_source() -> str:
    if unicodedata.unidata_version != "16.0.0":
        raise SystemExit("需要 Unicode 16.0.0 的 Python；禁止静默改变工具数字基准")
    digits = {code: value for code in range(0x110000)
              if (value := unicodedata.decimal(chr(code), None)) is not None}
    starts = [code for code, value in digits.items() if value == 0]
    covered = {}
    for start in starts:
        for value in range(10):
            code = start + value
            if digits.get(code) != value or unicodedata.category(chr(code)) != "Nd":
                raise SystemExit("Unicode 十进制数字组不连续，停止生成")
            covered[code] = value
    if covered != digits or len(digits) != 760 or len(starts) != 76:
        raise SystemExit("Unicode 16 十进制数字集合不符合固定基准")
    extra_digits = [code for code in range(0x110000) if chr(code).isdigit() and code not in digits]
    if len(extra_digits) != 128:
        raise SystemExit("Unicode 16 isdigit 非十进制集合不符合固定基准")
    lines = ["  " + ", ".join(f"0x{start:x}" for start in starts[index:index + 8]) + ","
             for index in range(0, len(starts), 8)]
    pattern = "[" + "".join("\\u{" + format(start, "x") + "}-\\u{" + format(start + 9, "x") + "}"
                            for start in starts) + "]"
    return """// 由 scripts/generate-tool-unicode.py 生成；不要手工修改数字表。
// 来源：CPython 3.14 unicodedata.decimal，Unicode 16.0.0；760个数字/76个连续组。
// 不使用Node/ICU的Unicode属性；十进制转换仅处理Nd，isdigit保留Python的独立判定语义。
const decimalStarts: readonly number[] = Object.freeze([
""" + "\n".join(lines) + """
])

/** Unicode16 Nd精确字符类；组合RegExp时须使用u标志。 */
export const decimalDigitPattern = """ + json.dumps(pattern) + """

// Python isdigit额外接受的128个非十进制字符；不将它们转换成十进制ID。
const extraDigit = new RegExp(""" + json.dumps("^" + character_class(extra_digits) + "$") + """, 'u')

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
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅检查生成物，不写入")
    arguments = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / "src/shared/unicode-decimal.ts"
    source = generated_source()
    if arguments.check:
        if target.read_text(encoding="utf-8") != source:
            raise SystemExit("工具 Unicode 数字生成物与 Python 基准不一致")
    else:
        target.write_text(source, encoding="utf-8")
