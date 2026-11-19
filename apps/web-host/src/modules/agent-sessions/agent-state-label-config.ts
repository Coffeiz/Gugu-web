type JsonRecord = Record<string, unknown>
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)

function pythonReprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let result = quote
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === quote || char === '\\') result += `\\${char}`
    else if (char === '\n') result += '\\n'
    else if (char === '\r') result += '\\r'
    else if (char === '\t') result += '\\t'
    else if (char !== ' ' && /[\p{C}\p{Z}]/u.test(char)) result += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`
    else result += char
  }
  return result + quote
}

function pythonRepr(value: unknown): string {
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return pythonReprString(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`
  if (record(value)) return `{${Object.entries(value).map(([key, item]) => `${pythonReprString(key)}: ${pythonRepr(item)}`).join(', ')}}`
  throw new TypeError('状态标签配置包含无效 JSON 值')
}

/** 输入是 Host 已解析的 JSON；读取失败原样传播，不改写配置。 */
export function createAgentStateLabelOverrides(readConfig: () => unknown) {
  return (): Record<string, string> => {
    const config = readConfig(), raw = record(config) ? config.state_labels : null
    if (!record(raw)) return {}
    const overrides = Object.hasOwn(raw, 'overrides') ? raw.overrides : raw
    if (!record(overrides)) return {}
    return Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, typeof value === 'string' ? value : pythonRepr(value)]))
  }
}
