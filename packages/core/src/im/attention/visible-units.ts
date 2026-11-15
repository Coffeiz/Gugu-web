import { strip } from '../../shared/values.js'

export interface VisibleAttentionUnit {
  text: string
  start: number
  end: number
  terminator: string | null
}

const patterns = [
  /```[^\n]*\n.*?(?:```|$)|~~~[^\n]*\n.*?(?:~~~|$)/gs,
  /`[^`\n]*`/g,
  /^\s*>.*(?:\n|$)/gm,
  /[“「『"'][^”」』"']*[”」』"']/g,
]
const trimChars = new Set(Array.from(' \t\r\n，,。.!！;；:：'))
const sentenceEnds = new Set(Array.from('。！？!?；;，,\n'))
const whitespace = (value: string) => strip(value).length === 0

/** 屏蔽代码与引用，同时保留 Python 码点偏移和可见字符位置。 */
export function visibleAttentionUnits(text: string): { units: VisibleAttentionUnit[]; uncertain: boolean; visiblePrefix: number[] } {
  const source = String(text || '')
  const masked = Array.from(source)
  const count = (needle: string) => source.split(needle).length - 1
  const uncertain = count('```') % 2 === 1 || count('~~~') % 2 === 1
  for (const pattern of patterns) {
    const view = masked.join('')
    pattern.lastIndex = 0
    for (const match of view.matchAll(pattern)) {
      const begin = Array.from(view.slice(0, match.index)).length
      const end = begin + Array.from(match[0]).length
      for (let index = begin; index < end; index++) if (masked[index] !== '\r' && masked[index] !== '\n') masked[index] = ' '
    }
  }
  const visiblePrefix = [0]
  for (const char of masked) visiblePrefix.push(visiblePrefix.at(-1)! + Number(!whitespace(char)))
  const units: VisibleAttentionUnit[] = []
  let start = 0
  const boundaries = masked.flatMap((char, index) => sentenceEnds.has(char) ? [index + 1] : [])
  if (boundaries.at(-1) !== masked.length) boundaries.push(masked.length)
  for (const end of boundaries) {
    let left = start, right = end, terminator: string | null = null
    for (let index = end - 1; index >= start; index--) if (!whitespace(masked[index]!)) { terminator = masked[index]!; break }
    while (left < right && trimChars.has(masked[left]!)) left++
    while (right > left && trimChars.has(masked[right - 1]!)) right--
    const unit = masked.slice(left, right).join('')
    if (left < right && strip(unit)) units.push({ text: unit, start: left, end: right, terminator })
    start = end
  }
  return { units, uncertain, visiblePrefix }
}
