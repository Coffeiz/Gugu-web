const special = /([_*\[\]()~`>#+\-=|{}.!\\])/gu
const fenceLine = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u
const inlineCode = /`([^`\n]+)`/gu
const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/gu
const bold = /\*\*([^*\n]+?)\*\*/gu
const italic = /(?<!\*)\*([^*\n]+?)\*(?!\*)/gu
const underlineItalic = /(?<!_)_([^_\n]+?)_(?!_)/gu
const strike = /~~([^~\n]+?)~~/gu
const heading = /^#{1,6}\s+(.+)$/gmu
const listItem = /^([ \t]*)([-+*]|\d+[.)])\s+(.*)$/gmu

const utf16Length = (value: string): number => value.length

export function escapeTelegramMarkdownV2(value: unknown): string {
  return String(value ?? '').replace(special, '\\$1')
}

function escapeCode(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')
}

type FenceBlock = { start: number; end: number; info: string; content: string }

function fencedCodeBlocks(text: string): FenceBlock[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  const blocks: FenceBlock[] = []
  for (let index = 0; index < lines.length;) {
    const openingLine = lines[index]!.replace(/[\r\n]+$/u, '')
    const opening = fenceLine.exec(openingLine)
    if (!opening) { index += 1; continue }
    const marker = opening[1]!, info = opening[2]!, char = marker[0]!, size = marker.length
    if (char === '`' && info.includes('`')) { index += 1; continue }
    let closingIndex = index + 1
    for (; closingIndex < lines.length; closingIndex += 1) {
      const closing = fenceLine.exec(lines[closingIndex]!.replace(/[\r\n]+$/u, ''))
      if (closing && closing[1]![0] === char && closing[1]!.length >= size && !closing[2]!.trim()) break
    }
    const contentStart = offsets[index]! + lines[index]!.length
    if (closingIndex === lines.length) {
      blocks.push({ start: offsets[index]!, end: text.length, info: info.trim(), content: text.slice(contentStart) })
      break
    }
    const contentEnd = offsets[closingIndex]!
    const blockEnd = contentEnd + lines[closingIndex]!.replace(/[\r\n]+$/u, '').length
    blocks.push({ start: offsets[index]!, end: blockEnd, info: info.trim(), content: text.slice(contentStart, contentEnd) })
    index = closingIndex + 1
  }
  return blocks
}

function safeLanguage(info: string): string {
  const language = info.split(/\s+/u, 1)[0] ?? ''
  return /^[A-Za-z0-9_+-]*$/u.test(language) ? language : ''
}

function convertListItem(_match: string, indent: string, originalMarker: string, originalContent: string): string {
  const checkbox = /^\[([ xX])\]\s+(.*)$/u.exec(originalContent)
  if (/^\d/u.test(originalMarker)) {
    const marker = originalMarker.replace(/[.)]$/u, '.')
    return `${indent}${marker} ${originalContent}`
  }
  if (checkbox) return `${indent}${checkbox[1]!.trim() ? '☑' : '☐'} ${checkbox[2]!}`
  return `${indent}• ${originalContent}`
}

function splitCodeContent(content: string, language: string, limit: number): string[] {
  const prefix = '```' + language + '\n', suffix = '```'
  const available = limit - utf16Length(prefix + suffix)
  const pieces: string[] = []
  let current = '', currentLength = 0
  for (const char of content) {
    const escaped = escapeCode(char), cost = utf16Length(escaped)
    if (current && currentLength + cost > available) {
      pieces.push(prefix + current + suffix); current = ''; currentLength = 0
    }
    current += escaped; currentLength += cost
  }
  if (current || pieces.length === 0) pieces.push(prefix + current + suffix)
  return pieces
}

export function markdownV2(text: unknown): string {
  let source = String(text ?? '')
  const protectedValues: string[] = []
  const keep = (value: string): string => {
    const marker = `\uE000${protectedValues.length}\uE001`
    protectedValues.push(value)
    return marker
  }
  for (const block of [...fencedCodeBlocks(source)].reverse()) {
    const language = safeLanguage(block.info)
    source = source.slice(0, block.start) + keep('```' + language + '\n' + escapeCode(block.content) + '```') + source.slice(block.end)
  }
  source = source.replace(listItem, convertListItem)
  source = source.replace(inlineCode, (_match, code: string) => keep('`' + escapeCode(code) + '`'))
  source = source.replace(linkPattern, (_match, label: string, url: string) => {
    let safe = false
    try { const parsed = new URL(url); safe = ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.host) } catch { safe = false }
    if (!safe) return keep(`${escapeTelegramMarkdownV2(label)} (${escapeTelegramMarkdownV2(url)})`)
    return keep(`[${escapeTelegramMarkdownV2(label)}](${url.replaceAll('\\', '\\\\').replaceAll(')', '\\)')})`)
  })
  source = source.replace(heading, (_match, value: string) => keep(`*${escapeTelegramMarkdownV2(value)}*`))
  source = source.replace(bold, (_match, value: string) => keep(`*${escapeTelegramMarkdownV2(value)}*`))
  source = source.replace(strike, (_match, value: string) => keep(`~${escapeTelegramMarkdownV2(value)}~`))
  source = source.replace(italic, (_match, value: string) => keep(`_${escapeTelegramMarkdownV2(value)}_`))
  source = source.replace(underlineItalic, (_match, value: string) => keep(`_${escapeTelegramMarkdownV2(value)}_`))
  let escaped = escapeTelegramMarkdownV2(source)
  protectedValues.forEach((value, index) => { escaped = escaped.replaceAll(`\uE000${index}\uE001`, value) })
  return escaped
}

function plainChunks(text: string, limit: number): string[] {
  const chunks: string[] = []
  let current = '', currentCost = 0
  for (const char of text) {
    const escapedCost = escapeTelegramMarkdownV2(char).length
    const cost = Math.max(escapedCost, utf16Length(char))
    if (current && currentCost + cost > limit) {
      chunks.push(escapeTelegramMarkdownV2(current)); current = ''; currentCost = 0
    }
    current += char; currentCost += cost
  }
  if (current || chunks.length === 0) chunks.push(escapeTelegramMarkdownV2(current))
  return chunks
}

export function splitMarkdownV2(text: unknown, limit = 4096): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('Telegram 消息长度限制无效')
  const raw = String(text ?? '')
  if (utf16Length(markdownV2(raw)) <= limit) return [markdownV2(raw)]
  const blocks = fencedCodeBlocks(raw)
  if (blocks.length === 0) return plainChunks(raw.replace(listItem, convertListItem), Math.max(1, limit - 32))
  const chunks: string[] = []
  let current = ''
  const flush = () => { if (current) { chunks.push(current); current = '' } }
  const appendUnit = (value: string, plainSource?: string) => {
    if (!value) return
    if (utf16Length(value) > limit) {
      flush(); chunks.push(...plainChunks((plainSource ?? value).replace(listItem, convertListItem), Math.max(1, limit - 32))); return
    }
    if (current && utf16Length(current + value) > limit) flush()
    current += value
  }
  let cursor = 0
  for (const block of blocks) {
    const segment = raw.slice(cursor, block.start)
    appendUnit(markdownV2(segment), segment); flush()
    for (const code of splitCodeContent(block.content, safeLanguage(block.info), limit)) { appendUnit(code); flush() }
    cursor = block.end
  }
  const segment = raw.slice(cursor)
  appendUnit(markdownV2(segment), segment); flush()
  return chunks
}
