/** 复现 Pydantic int 对整数数字字符串的请求 DTO 转换；非整数文本仍交给 schema 拒绝。 */
export function pydanticIntegerInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  return /^[+-]?\d+$/.test(normalized) ? Number(normalized) : value
}
