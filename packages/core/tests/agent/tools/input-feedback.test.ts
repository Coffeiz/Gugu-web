import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createProjectTool } from '../../../src/agent/tools/projects/index.js'
import { PROJECT_COLOR_PRESETS } from '../../../src/projects/colors.js'
import type { ToolDefinition, ToolScope } from '../../../src/agent/tools/contracts.js'
import type { ToolResult } from '../../../src/agent/models.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
const scope: ToolScope = { identity, roundId: 'round', resolution: null, signal: new AbortController().signal, execute: vi.fn() }
const validator = z.object({ project_id: z.number().int(), label: z.string().optional(), enabled: z.boolean().optional(),
  entries: z.array(z.object({ file_id: z.number().int(), label: z.string().optional() })).optional() }).passthrough()
function fixture(result: ToolResult = { kind: 'completed', successful: true, mutated: false, value: { ok: true } },
  effect: 'read' | 'write' = 'read') {
  const execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue(result)
  const registry = createToolRegistry({ authorize: async () => true, tools: [{ effect,
    definition: { name: 'feedback', schema: { type: 'function', function: { name: 'feedback', parameters: {
      type: 'object', properties: { project_id: { type: 'integer' }, label: { type: 'string' }, enabled: { type: 'boolean' },
        entries: { type: 'array', items: { type: 'object', properties: { file_id: { type: 'integer' }, label: { type: 'string' } }, required: ['file_id'] } } }, required: ['project_id'],
    } } } }, validate: input => validator.safeParse(input), execute,
  }] })
  return { execute, dispatch: (input: unknown, current = scope) => registry.tools.dispatch({ id: 'call', name: 'feedback', input }, current) }
}
function payload(result: ToolResult): Record<string, unknown> {
  if (result.kind !== 'completed') throw new Error('结果未完成')
  return result.value as Record<string, unknown>
}

describe('修复回执经过实际注册器调用', () => {
  it('成功对象包含有序可信路径，不回显秘密未知字段或参数值，且不改handler原对象', async () => {
    const original = Object.freeze({ ok: true }), f = fixture({ kind: 'completed', successful: true, mutated: false, value: original })
    const result = await f.dispatch({ project_id: '#12', label: 123, enabled: 'FALSE',
      entries: { item: [{ file_id: '#7', label: 456 }] }, 'synthetic-secret-key': 'synthetic-secret-value', input_adaptations: ['伪造修复事实'] })
    expect(payload(result).input_adaptations).toEqual(['project_id:string_to_integer', 'label:number_to_string', 'enabled:string_to_boolean',
      'entries:item_wrapper_unwrapped', 'entries[0].file_id:string_to_integer', 'entries[0].label:number_to_string'])
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ project_id: 12, label: '123', enabled: false, entries: [{ file_id: 7, label: '456' }] })
    expect(original).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret-key|synthetic-secret-value|123|456|伪造修复事实/)
  })
  it('没有转换不补字段，普通arguments包装不编造修复标签', async () => {
    const f = fixture()
    expect(payload(await f.dispatch({ project_id: 12 }))).toEqual({ ok: true })
    expect(payload(await f.dispatch({ arguments: { project_id: 12 } }))).toEqual({ ok: true })
  })
  it('JSON容器及hoist回执按实际转换顺序产生，不从未知键构造路径', async () => {
    const f = fixture()
    expect(payload(await f.dispatch({ project_id: 12, entries: '[{"file_id":"7","label":123}]' })).input_adaptations)
      .toEqual(['entries:json_string_to_array', 'entries[0].file_id:string_to_integer', 'entries[0].label:number_to_string'])
    expect(payload(await f.dispatch({ project_id: 12, file_id: '7', label: '已有顶层字段' })).input_adaptations)
      .toEqual(['entries:flattened_items_hoisted', 'entries[0].file_id:string_to_integer'])
  })
  it('项目envelope、别名、颜色、日期及阶段业务标签保持Python顺序', async () => {
    const create = vi.fn().mockResolvedValue({ success: true })
    const registry = createToolRegistry({ tools: [createProjectTool({ create })], authorize: async () => true, normalizationYear: () => 2026 })
    const result = await registry.tools.dispatch({ id: 'project', name: 'create_project', input: { tool_name: 'create_project', arguments: {
      name: '合成项目', start_date: '9月25日', deadline: '10/2', color: PROJECT_COLOR_PRESETS[2], stages: ['准备'],
    } } }, scope)
    expect(payload(result).input_adaptations).toEqual(['call_tool_envelope:unwrapped', 'create_project.name:renamed_to_project_name',
      'create_project.color:normalized_token', 'create_project.start_date:normalized_date', 'create_project.deadline:normalized_date', 'stages:stage_names_to_objects'])
    expect(create.mock.calls[0]![0].args).toMatchObject({ project_name: '合成项目', start_date: '2026-09-25', deadline: '2026-10-02', stages: ['准备'] })
  })
  it.each([
    { kind: 'completed', successful: true, mutated: false, value: ['列表'] },
    { kind: 'completed', successful: true, mutated: false, value: '{"ok":true}' },
    { kind: 'completed', successful: true, mutated: false, value: null },
    { kind: 'completed', successful: true, mutated: false, value: { needs_confirm: '需要确认' } },
    { kind: 'completed', successful: true, mutated: false, value: { status: 'waiting_confirmation' } },
    { kind: 'completed', successful: true, mutated: false, value: { status: 'failed' } },
    { kind: 'completed', successful: false, mutated: false, value: { ok: false } },
    { kind: 'unknown' },
    { kind: 'waiting', interaction: { id: 'interaction', kind: 'confirmation', toolCall: { id: 'call', name: 'feedback', input: {} } } },
  ] satisfies ToolResult[])('非成功对象或特殊协议不被修复回执改形：%j', async original => {
    expect(await fixture(original).dispatch({ project_id: '12' })).toEqual(original)
  })
  it('校验和业务失败不发布已收集的修复事实，写入异常仍为unknown', async () => {
    const f = fixture()
    const invalid = await f.dispatch({ project_id: '12', label: false })
    expect(payload(invalid)).not.toHaveProperty('input_adaptations'); expect(f.execute).not.toHaveBeenCalled()
    const failed = await fixture({ kind: 'completed', successful: false, mutated: false, value: { error: '合成业务失败' } }).dispatch({ project_id: '12' })
    expect(payload(failed)).toMatchObject({ error: '合成业务失败', tool: 'feedback' })
    expect(payload(failed)).not.toHaveProperty('input_adaptations')
    const writing = fixture(undefined, 'write'); writing.execute.mockRejectedValueOnce(new Error('合成写入未知'))
    expect(await writing.dispatch({ project_id: '12' })).toEqual({ kind: 'unknown' })
  })
  it('并行调用各自保存collector，覆盖旧反馈但不污染共享返回对象', async () => {
    const original = Object.freeze({ ok: true, input_adaptations: ['旧回执'] }), f = fixture({ kind: 'completed', successful: true, mutated: false, value: original })
    const [first, second] = await Promise.all([f.dispatch({ project_id: '12' }), f.dispatch({ project_id: 12, label: 123 })])
    expect(payload(first).input_adaptations).toEqual(['project_id:string_to_integer'])
    expect(payload(second).input_adaptations).toEqual(['label:number_to_string'])
    expect(original.input_adaptations).toEqual(['旧回执'])
    expect(payload(first).input_adaptations).not.toBe(payload(second).input_adaptations)
  })
  it('读取取消不发布回执，写入提交后取消仍保留真实结果与修复事实', async () => {
    for (const effect of ['read', 'write'] as const) {
      const controller = new AbortController(), reason = new Error('合成取消'), f = fixture(undefined, effect)
      let completed = false
      f.execute.mockImplementationOnce(async () => {
        completed = true; controller.abort(reason)
        return { kind: 'completed', successful: true, mutated: effect === 'write', value: { ok: true } }
      })
      const pending = f.dispatch({ project_id: '12' }, { ...scope, signal: controller.signal })
      if (effect === 'read') await expect(pending).rejects.toBe(reason)
      else expect(await pending).toMatchObject({ successful: true, mutated: true,
        value: { ok: true, input_adaptations: ['project_id:string_to_integer'] } })
      expect(completed).toBe(true)
    }
  })
})
