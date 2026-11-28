import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { enrichToolError, invalidInputResult } from '../../../src/agent/tools/input-errors.js'
import { createProjectTool } from '../../../src/agent/tools/projects/index.js'
import type { PreparedToolDefinition, ToolResult } from '../../../src/agent/models.js'
function payload(result: ToolResult): Record<string, any> { if (result.kind !== 'completed') throw new Error('未完成'); return result.value as Record<string, any> }
const tool: PreparedToolDefinition = { name: 'sample', schema: { type: 'function', function: { name: 'sample', parameters: { type: 'object', properties: { id: { type: 'integer' }, text: { type: 'string', minLength: 2, maxLength: 3 }, mode: { type: 'string', enum: ['one', 'two'] }, enabled: { type: 'boolean' } }, required: ['id'], additionalProperties: false } } } }
describe('输入错误的安全投影', () => {
  it('缺必填字段保持Python结构并指示先询问，不暴露输入值', () => {
    const result = invalidInputResult(tool, { text: '秘密正文' })
    expect(result).toMatchObject({ executed: false, successful: false, mutated: false })
    expect(payload(result)).toMatchObject({ error: 'tool_input_invalid', tool: 'sample', _schema_recovery: { needed: true, reason: 'validation_error' }, issues: [{ path: 'id', rule: 'required', message: '缺少必填字段 id' }, { path: 'text', rule: 'maxLength', message: '字段长度不能大于 3' }] })
    expect(payload(result).next_action).toContain('请补齐必填字段：id')
    expect(JSON.stringify(result)).not.toContain('秘密正文')
  })
  it('任意未知字段与原始Zod消息不回显，路径只沿公开schema', () => {
    const result = invalidInputResult(tool, { id: 1, 'token-secret': 'credential' }, { issues: [{ path: ['token-secret'], code: 'unrecognized_keys', message: 'credential', input: 'secret' }] })
    expect(payload(result).issues).toEqual([{ path: '$', rule: 'additionalProperties', message: '包含 schema 未允许的额外字段' }])
    expect(JSON.stringify(result)).not.toMatch(/token-secret|credential/)
    const custom = invalidInputResult(tool, { id: 1 }, { issues: [{ path: ['token-secret'], code: 'custom', message: 'credential' }] })
    expect(payload(custom).issues[0].path).toBe('$')
    expect(JSON.stringify(custom)).not.toMatch(/token-secret|credential/)
  })
  it('稳定排序去重后最多五项，不随Zod输入顺序改变', () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string() })
    const definition = { name: 'many', schema: { function: { parameters: z.toJSONSchema(schema) } } } as unknown as PreparedToolDefinition
    expect(payload(invalidInputResult(definition, {})).issues.map((item: any) => item.path)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('类型和枚举提示仅取可信schema，boolean对string有固定纠错动作', () => {
    const result = payload(invalidInputResult(tool, { id: 'secret-id', mode: 'secret-enum', text: false }))
    expect(result.issues.map((item: any) => [item.path, item.rule])).toEqual([['id', 'type'], ['mode', 'enum'], ['text', 'type']])
    expect(result.schema_hints).toContain('mode 必须是允许的枚举值：one、two。不要传视觉描述或 CSS 值。')
    expect(result.next_action).toContain('不要再次传入裸 true/false')
    expect(JSON.stringify(result)).not.toMatch(/secret-id|secret-enum/)
  })
  it('真实create_project schema深层stages错误有安全索引、规则与扁平数组修复', () => {
    const project = createProjectTool({ create: async () => ({ success: true }) })
    const input = { project_name: '项目', start_date: 'wrong-secret-date', deadline: '2026-11-30', stages: [{ label: '设计', todos: [''] }] }
    const parsed = project.validate(input)
    expect(parsed.success).toBe(false)
    const result = payload(invalidInputResult(project.definition, input, parsed.success ? undefined : parsed))
    expect(result.issues).toContainEqual({ path: 'stages.0.todos.0', rule: 'minLength', message: '字段长度不能小于 1' })
    expect(result.issues).toContainEqual({ path: 'start_date', rule: 'pattern', message: '字段格式不符合要求' })
    expect(result.next_action).toContain('重建报错数组')
    expect(JSON.stringify(result)).not.toContain('wrong-secret-date')
  })
  it('支持可信数组、数值边界与uniqueItems，不转发自定义异常', () => {
    const definition = { name: 'bounded', schema: { function: { parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 }, items: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } } } } } } } as PreparedToolDefinition
    expect(payload(invalidInputResult(definition, { count: 0, items: ['a', 'a', 'a'] })).issues.map((item: any) => item.rule)).toEqual(['minimum', 'maxItems', 'uniqueItems'])
  })
  it.each([null, [], 'secret', 12, false])('非object输入只返回根类型错误 %j', input => {
    expect(payload(invalidInputResult(tool, input)).issues).toEqual([{ path: '$', rule: 'type', message: '工具输入必须是 object' }])
  })
})
describe('业务错误增强保留返回类型', () => {
  it('对象和JSON字符串保留业务字段与已有提示、不原地修改', () => {
    const original = { error: '联系人不存在', candidates: [{ id: 1, name: '小北' }], next_action: '保留动作' }
    const result = enrichToolError('update_client', original) as any
    expect(result).toMatchObject({ ...original, tool: 'update_client' })
    expect(result.usage_hint).toContain('先根据错误信息')
    expect(original).not.toHaveProperty('tool')
    const string = enrichToolError('update_client', JSON.stringify(original))
    expect(typeof string).toBe('string')
    expect(JSON.parse(string as string)).toEqual(result)
  })
  it('未知工具使用协议纠错提示，其余列表、成功、unknown保持原样', () => {
    expect(enrichToolError('missing', { error: 'unknown_tool' })).toMatchObject({ next_action: expect.stringContaining('本轮工具列表') })
    for (const value of [[{ error: 'entry' }], { success: true }, { kind: 'unknown' }, 'not-json']) expect(enrichToolError('sample', value)).toBe(value)
  })
})
