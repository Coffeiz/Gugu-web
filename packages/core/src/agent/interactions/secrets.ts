const fieldNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Python `normalize_secret_fields` 的共享字段定义校验；无效描述返回 null。 */
export function normalizeSecretFields(raw: unknown, maxFields = 16): Array<{ name: string; label: string; type: 'secret' }> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxFields) return null
  const result: Array<{ name: string; label: string; type: 'secret' }> = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!record(value) || (value.type !== undefined && value.type !== 'secret')) return null
    const name = String(value.name || '').trim()
    const label = String(value.label || name).trim()
    if (!fieldNamePattern.test(name) || !label || label.length > 120 || seen.has(name)) return null
    seen.add(name)
    result.push({ name, label, type: 'secret' })
  }
  return result
}

/** Python `validate_secret_values` 的共享规则；只返回当前 prompt 声明的字段。 */
export function validateSecretValues(fields: readonly Record<string, unknown>[], values: unknown): Record<string, string> {
  if (!record(values)) throw new TypeError('敏感字段值必须是 JSON 对象')
  const allowed = new Set(fields.map(field => String(field.name || '')))
  const keys = Object.keys(values)
  if (allowed.size === 0 || keys.length !== allowed.size || keys.some(key => !allowed.has(key))) throw new Error('敏感字段不匹配')
  const normalized: Record<string, string> = Object.create(null)
  for (const key of keys) {
    const value = values[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('敏感字段不能为空或过长')
    normalized[key] = value.trim()
  }
  return normalized
}

/** Python `resolved_prompt_result` 的安全回执，不包含提交的敏感值。 */
export function resolvedSecretPromptResult(promptId: number) {
  return { kind: 'form' as const, status: 'answered' as const, prompt_id: promptId, option_id: null, value: null, text: '敏感信息已安全保存' }
}
