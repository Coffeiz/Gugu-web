/** 仅迁移正文中的技能引用，保留代码围栏、行内代码、转义文本和原有换行。 */
export function migrateMindSkillReferences(markdown: string, ids: ReadonlyMap<string, string>): string {
  let fence: string | undefined
  const lines = markdown.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(Boolean) ?? []
  const fenceMasked = lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      const closing = /^ {0,3}([~`]+)([^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*)/u.exec(line)
      if (closing && closing[1]!.length >= fence.length && [...closing[1]!].every(char => char === fence![0]) && !closing[2]!.trim()) fence = undefined
      return line.replace(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g, ' ')
    }
    if (marker) { fence = marker[1]; return line.replace(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g, ' ') }
    return line
  }).join('')
  // 等长遮罩保留匹配下标，也覆盖跨行的行内代码。
  const masked = fenceMasked.replace(/(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/gu, match => ' '.repeat(match.length))
  const pattern = /\[\[skill:(U[1-9][0-9]*|[0-9]+)\|([^\]]*)\]\]/gu
  let start = 0, result = ''
  for (const match of masked.matchAll(pattern)) {
    const index = match.index!
    let before = index - 1
    while (before >= 0 && masked[before] === '\\') before--
    if ((index - 1 - before) % 2) continue
    const slug = ids.get(match[1]!)
    if (!slug) continue
    const idStart = index + '[[skill:'.length
    result += markdown.slice(start, idStart) + slug
    start = idStart + match[1]!.length
  }
  return result + markdown.slice(start)
}
