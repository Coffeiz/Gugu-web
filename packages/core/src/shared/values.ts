import { CoreError } from '../contracts/error.js'

export function invalid(message: string): never {
  throw new CoreError('invalid_request', message)
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('必须提供对象')
}
export function onlyFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('包含不支持的字段')
}
export function safeInteger(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    invalid('整数参数无效')
  return value
}
// 对齐 Python str.strip 的空白集合，包括四个分隔控制符，保留 BOM。
const stripWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u
export function strip(value: string): string {
  let start = 0, end = value.length
  // 单字符判定、双端扫描，避免长内部空白在尾部匹配失败时重复回溯。
  while (start < end && stripWhitespace.test(value[start]!)) start++
  while (end > start && stripWhitespace.test(value[end - 1]!)) end--
  return value.slice(start, end)
}
export function length(value: string): number {
  return Array.from(value).length
}
// 兼容旧 stages_json 的 JSON 分隔符；不替换字符串内部字符。
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(', ')}}`
  const result = JSON.stringify(value)
  if (result === undefined) invalid('值不能序列化')
  return result
}
