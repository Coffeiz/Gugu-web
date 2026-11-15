"""用生产 Python 3.14 的 Unicode 16 数据重建搜索大小写表；不读取运行配置。"""

import argparse
import json
from pathlib import Path
import unicodedata


def character_class(codepoints: list[int]) -> str:
    """连续区间压缩成固定版本的Unicode码点字符类。"""
    ranges: list[tuple[int, int]] = []
    for codepoint in codepoints:
        if ranges and codepoint == ranges[-1][1] + 1:
            ranges[-1] = ranges[-1][0], codepoint
        else:
            ranges.append((codepoint, codepoint))
    def escaped(value: int) -> str:
        return "\\u{" + format(value, "x") + "}"
    return "[" + "".join(escaped(start) if start == end else escaped(start) + "-" + escaped(end)
                         for start, end in ranges) + "]"


def generated_source() -> str:
    if unicodedata.unidata_version != "16.0.0":
        raise SystemExit("需要 Unicode 16.0.0 的 Python；禁止静默改变搜索基准")
    mappings = []
    lower_overrides = []
    cased = []
    case_ignorable = []
    for codepoint in range(0x110000):
        character = chr(codepoint)
        folded = character.casefold()
        lowered = character.lower()
        if lowered != folded:
            lower_overrides.append(f"  {codepoint}: {json.dumps(lowered, ensure_ascii=True)},")
        if character.islower() or character.isupper() or character.istitle():
            cased.append(codepoint)
        # 双探针由CPython自己的Final_Sigma上下文规则推导CI，含同时属于Cased的组合字符。
        if ("A" + character + "Σ").lower().endswith("ς") and not ("!" + character + "Σ").lower().endswith("ς"):
            case_ignorable.append(codepoint)
        if folded != character:
            mappings.append(f"  {codepoint}: {json.dumps(folded, ensure_ascii=True)},")
    return """// 由 scripts/generate-search-unicode.py 生成；不要手工编辑映射。
// 来源：CPython 3.14 str.casefold/str.lower，Unicode 16.0.0，与当前生产 Python 基准一致。
// 使用完整映射，不依赖 Node/ICU 的 Unicode 版本；不执行 NFKC 或土耳其语特例。
const folding: Readonly<Record<number, string>> = Object.freeze({
""" + "\n".join(mappings) + """
})

/** Unicode16完整折叠；用于查询去重和片段选词，不改变原词或数据库匹配。 */
export function casefoldSearchText(value: string): string {
  return Array.from(value, character => folding[character.codePointAt(0)!] ?? character).join('')
}

""" + "const lowerOverrides: Readonly<Record<number, string>> = Object.freeze({\n" + "\n".join(lower_overrides) + """
})

// 固定Unicode16类别；不依赖Node/ICU的属性版本。
""" + "const cased = /^" + character_class(cased) + "$/u\n" + "const caseIgnorable = /^" + character_class(case_ignorable) + "$/u\n" + """

/** Python Unicode16默认lower，含Final_Sigma上下文；不执行locale变体、casefold或NFKC。 */
export function lowerSearchText(value: string): string {
  const characters = Array.from(value), nextCased = new Uint8Array(characters.length)
  let following = false
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index]!
    nextCased[index] = Number(following)
    if (!caseIgnorable.test(character)) following = cased.test(character)
  }
  let preceding = false
  const result: string[] = []
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!, codepoint = character.codePointAt(0)!
    result.push(character === 'Σ' && preceding && nextCased[index] === 0
      ? 'ς' : lowerOverrides[codepoint] ?? folding[codepoint] ?? character)
    if (!caseIgnorable.test(character)) preceding = cased.test(character)
  }
  return result.join('')
}

"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅检查生成物，不写入")
    arguments = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / "src/search/unicode.ts"
    source = generated_source()
    if arguments.check:
        if target.read_text(encoding="utf-8") != source:
            raise SystemExit("搜索 Unicode 生成物与 Python 基准不一致")
    else:
        target.write_text(source, encoding="utf-8")
