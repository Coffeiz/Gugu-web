/** Python/Pydantic 查询布尔值；重复参数以最后一项为准。 */
export function pythonQueryBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined) return defaultValue
  const last = Array.isArray(value) ? value.at(-1) : value
  if (typeof last === 'boolean') return last
  if (typeof last === 'string') {
    const token = last.toLowerCase()
    if (['1', 'true', 't', 'on', 'yes', 'y'].includes(token)) return true
    if (['0', 'false', 'f', 'off', 'no', 'n'].includes(token)) return false
  }
  throw Object.assign(new Error('查询布尔参数无效'), {statusCode:422})
}
