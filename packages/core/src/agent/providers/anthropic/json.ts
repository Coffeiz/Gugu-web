import type { Json } from '../../harness/contracts.js'
import type { JsonObject } from '../contracts.js'
import { ProviderError } from '../errors.js'

const missing = Symbol('尚未完整接收的JSON值')
interface PartialValue { value: Json | typeof missing; complete: boolean }

/** 对齐 SDK 的 partial JSON：保留完成值，未完成字符串/标量不猜测补全。 */
export function parsePartialAnthropicObject(raw: string): JsonObject {
  if (!raw.trim()) return {}
  let position = 0
  const whitespace = () => { while (/[ \t\r\n]/.test(raw[position] ?? '') && position < raw.length) position++ }
  const invalid = (): never => { throw new ProviderError('protocol') }
  const incomplete = (value: Json | typeof missing = missing): PartialValue => ({ value, complete: false })
  function string(): PartialValue {
    const start = position++
    while (position < raw.length) {
      const char = raw[position++]!
      if (char === '"') {
        try { return { value: JSON.parse(raw.slice(start, position)) as string, complete: true } } catch { return invalid() }
      }
      if (char.charCodeAt(0) < 32) return invalid()
      if (char === '\\') {
        if (position === raw.length) return incomplete()
        const escaped = raw[position++]!
        if (!'"\\/bfnrtu'.includes(escaped)) return invalid()
        if (escaped === 'u') {
          const digits = raw.slice(position, position + 4)
          if (!/^[\da-f]*$/i.test(digits)) return invalid()
          if (digits.length < 4) { position = raw.length; return incomplete() }
          position += 4
        }
      }
    }
    return incomplete()
  }
  function value(depth: number): PartialValue {
    if (depth > 128) return invalid()
    whitespace()
    const char = raw[position]
    if (char === undefined) return incomplete()
    if (char === '"') return string()
    if (char === '{') {
      position++
      const result: JsonObject = {}
      whitespace()
      if (raw[position] === '}') { position++; return { value: result, complete: true } }
      while (position < raw.length) {
        whitespace()
        if (position === raw.length) return incomplete(result)
        if (raw[position] !== '"') return invalid()
        const key = string()
        if (!key.complete) return incomplete(result)
        if (typeof key.value !== 'string') return invalid()
        whitespace()
        if (position === raw.length) return incomplete(result)
        if (raw[position++] !== ':') return invalid()
        const item = value(depth + 1)
        if (item.value !== missing) Object.defineProperty(result, key.value, { value: item.value, enumerable: true, writable: true, configurable: true })
        if (!item.complete) return incomplete(result)
        whitespace()
        if (position === raw.length) return incomplete(result)
        const separator = raw[position++]
        if (separator === '}') return { value: result, complete: true }
        // SDK partial_mode 在已完成值之后停止于坏分隔符，保留这个完整前缀。
        if (separator !== ',') return incomplete(result)
      }
      return incomplete(result)
    }
    if (char === '[') {
      position++
      const result: Json[] = []
      whitespace()
      if (raw[position] === ']') { position++; return { value: result, complete: true } }
      while (position < raw.length) {
        const item = value(depth + 1)
        if (item.value !== missing) result.push(item.value)
        if (!item.complete) return incomplete(result)
        whitespace()
        if (position === raw.length) return incomplete(result)
        const separator = raw[position++]
        if (separator === ']') return { value: result, complete: true }
        if (separator !== ',') return incomplete(result)
      }
      return incomplete(result)
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (char !== literal[0]) continue
      const candidate = raw.slice(position, position + literal.length)
      if (candidate.length < literal.length && literal.startsWith(candidate)) { position = raw.length; return incomplete() }
      if (candidate !== literal) return invalid()
      position += literal.length
      return { value: parsed, complete: true }
    }
    if (char === '-' || /\d/.test(char)) {
      const start = position
      if (raw[position] === '-') position++
      if (position === raw.length) return incomplete()
      if (raw[position] === '0') position++
      else if (/[1-9]/.test(raw[position]!)) { while (/\d/.test(raw[position] ?? '') && position < raw.length) position++ }
      else return invalid()
      if (raw[position] === '.') {
        position++
        if (position === raw.length) return incomplete()
        if (!/\d/.test(raw[position]!)) return invalid()
        while (/\d/.test(raw[position] ?? '') && position < raw.length) position++
      }
      if (raw[position] === 'e' || raw[position] === 'E') {
        position++
        if (raw[position] === '+' || raw[position] === '-') position++
        if (position === raw.length) return incomplete()
        if (!/\d/.test(raw[position]!)) return invalid()
        while (/\d/.test(raw[position] ?? '') && position < raw.length) position++
      }
      const number = Number(raw.slice(start, position))
      return Number.isFinite(number) ? { value: number, complete: true } : invalid()
    }
    return invalid()
  }
  const result = value(0)
  whitespace()
  if (result.value === missing || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return invalid()
  return result.value
}
