import { describe, expect, it } from 'vitest'
import { normalizeSecretFields, resolvedSecretPromptResult, validateSecretValues } from '../../../src/agent/interactions/secrets.js'

describe('Agent 敏感字段交互规则', () => {
  it('规范字段定义并拒绝空、重复或超限字段', () => {
    expect(normalizeSecretFields([
      { name: ' api_key ', label: ' API Key ' },
      { name: 'region', type: 'secret' },
    ])).toEqual([
      { name: 'api_key', label: 'API Key', type: 'secret' },
      { name: 'region', label: 'region', type: 'secret' },
    ])
    expect(normalizeSecretFields([])).toBeNull()
    expect(normalizeSecretFields([{ name: 'key' }, { name: 'key' }])).toBeNull()
    expect(normalizeSecretFields([{ name: 'key', type: 'text' }])).toBeNull()
    expect(normalizeSecretFields(Array.from({ length: 17 }, (_, index) => ({ name: `key${index}` })))).toBeNull()
  })

  it('只接受当前 prompt 的完整字段集合并去除首尾空白', () => {
    const fields = [{ name: 'key' }, { name: 'region' }]
    expect(validateSecretValues(fields, { key: ' synthetic ', region: ' cn ' })).toEqual({ key: 'synthetic', region: 'cn' })
    expect(() => validateSecretValues(fields, { key: 'synthetic' })).toThrow('敏感字段不匹配')
    expect(() => validateSecretValues(fields, { key: 'synthetic', region: 'cn', extra: 'value' })).toThrow('敏感字段不匹配')
    expect(() => validateSecretValues(fields, null)).toThrow('敏感字段值必须是 JSON 对象')
    expect(() => validateSecretValues(fields, { key: ' ', region: 'cn' })).toThrow('敏感字段不能为空或过长')
    expect(() => validateSecretValues(fields, { key: 'x'.repeat(4097), region: 'cn' })).toThrow('敏感字段不能为空或过长')
  })

  it('完成回执不含密文或敏感值', () => {
    const result = resolvedSecretPromptResult(42)
    expect(result).toEqual({ kind: 'form', status: 'answered', prompt_id: 42, option_id: null, value: null, text: '敏感信息已安全保存' })
    expect(JSON.stringify(result)).not.toMatch(/secret|token|api_key/i)
  })
})
