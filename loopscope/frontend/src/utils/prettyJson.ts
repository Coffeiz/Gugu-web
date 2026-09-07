function quoteReadable(value: string): string {
  let result = '"'
  for (const char of value) {
    if (char === '\\') result += '\\\\'
    else if (char === '"') result += '\\"'
    else if (char === '\n' || char === '\r') result += '\n'
    else if (char === '\t') result += '\t'
    else {
      const code = char.charCodeAt(0)
      result += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char
    }
  }
  return result + '"'
}

function format(value: unknown, depth: number): string {
  const indent = '  '.repeat(depth)
  const childIndent = '  '.repeat(depth + 1)
  if (value === null) return 'null'
  if (typeof value === 'string') return quoteReadable(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return `[\n${value.map(item => `${childIndent}${format(item, depth + 1)}`).join(',\n')}\n${indent}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return '{}'
    return `{\n${entries.map(([key, item]) => `${childIndent}${JSON.stringify(key)}: ${format(item, depth + 1)}`).join(',\n')}\n${indent}}`
  }
  return String(value)
}

/** 保留 JSON 结构，同时让字符串中的真实换行在诊断面板中可读。 */
export function prettyJson(value: unknown): string {
  return format(value, 0)
}
