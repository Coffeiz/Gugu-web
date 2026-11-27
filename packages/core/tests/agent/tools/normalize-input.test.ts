import { describe, expect, it } from 'vitest'
import type { Json, PreparedToolDefinition } from '../../../src/agent/models.js'
import { normalizeToolInput } from '../../../src/agent/tools/normalize-input.js'

function definition(name = 'update_project'): PreparedToolDefinition {
  return { name, schema: { type: 'function', function: { name, parameters: { type: 'object', properties: {
    project_name: { type: 'string' }, client_name: { type: 'string' }, project_id: { type: 'integer' }, archived: { type: 'boolean' },
    summary: { type: ['string', 'null'] }, union: { type: ['string', 'number'] }, target_lines: { type: 'string' },
    start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    changes: { type: 'array', items: { type: 'object', properties: { file_id: { type: 'integer' }, enabled: { type: 'boolean' }, content: { type: 'string' } } } },
  } } } } }
}

describe('公开工具schema驱动的有限输入兼容', () => {
  it('完整非法日期保留给领域校验，不访问缺省年份服务', () => {
    const context = { get defaultYear(): number { throw new Error('不应查询年份') } }
    expect(normalizeToolInput(definition(), { start_date: '2026-02-30' }, context)).toEqual({ start_date: '2026-02-30' })
    expect(normalizeToolInput(definition(), { start_date: '2026/2/1' }, context)).toEqual({ start_date: '2026-02-01' })
  })
  it.each(['create_project', 'update_project'])('只在专属名称缺失时迁移%s的name', name => {
    const target = 'project_name'
    expect(normalizeToolInput(definition(name), { name: 123 })).toEqual({ [target]: '123' })
    expect(normalizeToolInput(definition(name), { name: '旧字段', [target]: '' })).toEqual({ name: '旧字段', [target]: '' })
    expect(normalizeToolInput(definition(name), { name: '旧字段', [target]: null })).toEqual({ name: '旧字段', [target]: null })
  })
  it('未知工具或未声明目标字段不猜名称别名', () => {
    expect(normalizeToolInput(definition('unknown'), { name: '原名' })).toEqual({ name: '原名' })
    const unknownSchema = { name: 'create_project', schema: { type: 'function', function: { parameters: { type: 'object', properties: {} } } } }
    expect(normalizeToolInput(unknownSchema, { name: '原名' })).toEqual({ name: '原名' })
  })
  it('按递归属性和数组items转换已提供标量，不修改输入', () => {
    const input = { project_id: ' #+23 ', archived: ' FaLsE ', summary: 12.5,
      changes: [{ file_id: '#7', enabled: 'TRUE', content: 42 }], unknown: '#99' }
    const saved = structuredClone(input)
    expect(normalizeToolInput(definition(), input)).toEqual({ project_id: 23, archived: false, summary: '12.5',
      changes: [{ file_id: 7, enabled: true, content: '42' }], unknown: '#99' })
    expect(input).toEqual(saved)
  })
  it('Python空白归一保留BOM并剥离C0，Unicode十进制数字按基准归一', () => {
    expect(normalizeToolInput(definition(), { project_id: '\u001c#3\u001f', archived: '\u001eTRUE\u001f', summary: null }))
      .toEqual({ project_id: 3, archived: true, summary: null })
    expect(normalizeToolInput(definition(), { project_id: '\ufeff3', archived: '\ufefffalse', summary: 0 }))
      .toEqual({ project_id: '\ufeff3', archived: '\ufefffalse', summary: '0' })
    // 关闭已记录的Unicode Nd差异：Python ^[+-]?\d+$ 接受全角十进制数字，仍须保留safe integer边界。
    expect(normalizeToolInput(definition(), { project_id: '１２' })).toEqual({ project_id: 12 })
  })
  it('不把布尔值变成文字，不转union数字，仅归一明确日期而不猜数组结构', () => {
    const input = { project_name: true, union: 5, start_date: '2026/1/2', changes: '{"item":[]}', target_lines: 3 }
    expect(normalizeToolInput(definition(), input)).toEqual({ ...input, start_date: '2026-01-02', target_lines: '3' })
    expect(normalizeToolInput(definition(), {})).toEqual({})
    expect(normalizeToolInput(definition(), { arguments: { project_id: '#3' } })).toEqual({ project_id: 3 })
  })
  it.each(['9007199254740992', '#9007199254740993', '1.2', '1e3', '0x10', '# 3', '', '  '])('非法或超safe整数%s留给validator拒绝', project_id => {
    expect(normalizeToolInput(definition(), { project_id })).toEqual({ project_id })
  })
  it('仅ID接受#前缀，普通integer字段只转换十进制', () => {
    const d: PreparedToolDefinition = { name: 'test', schema: { input_schema: { type: 'object', properties: { count: { type: 'integer' } } } } }
    expect(normalizeToolInput(d, { count: '#3' })).toEqual({ count: '#3' })
    expect(normalizeToolInput(d, { count: '+003' })).toEqual({ count: 3 })
  })
  it.each([null, [], '非法顶层', 1, true])('保留非法顶层值%j供validator拒绝', input => {
    expect(normalizeToolInput(definition(), input)).toEqual(input)
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { dataContext } from '../../../src/contracts/index.js'
import { createClientTools } from '../../../src/agent/tools/clients/index.js'
import { createListProjectsTool } from '../../../src/agent/tools/projects/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

describe('输入兼容经过真实 registry 与临时 SQLite', () => {
  it('旧名称、数字电话、文本ID及归档false归一后真实读写；重复批量ID不执行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-normalize-input-'))
    const path = join(root, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const registry = createToolRegistry({ tools: [...createClientTools(runtime), createListProjectsTool(runtime)], authorize: async () => true })
      const scope: ToolScope = { identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round', resolution: null,
        signal: new AbortController().signal, execute: async () => { throw new Error('不可执行命令') } }
      const dispatch = (name: string, input: unknown) => registry.tools.dispatch({ id: 'call', name, input }, scope)
      const made = await dispatch('create_client', { client_name: '旧字段联系人', phone: 12345 })
      expect(made).toMatchObject({ successful: true, value: { success: true, name: '旧字段联系人',
        input_adaptations: ['phone:number_to_string'] } })
      const rows = await runtime.transaction(dataContext(ownerId), data => data.clients.list())
      expect(rows).toHaveLength(1)
      expect(rows[0]!.phone).toBe('12345')
      expect(await dispatch('update_client', { client_id: `#${rows[0]!.id}`, name: '更新后联系人', phone: 67890 }))
        .toMatchObject({ successful: true, value: { success: true, name: '更新后联系人', input_adaptations: [
          'contact_id:string_to_integer', 'phone:number_to_string',
        ] } })
      const duplicate = await dispatch('update_client', { client_ids: [String(rows[0]!.id), rows[0]!.id], client_id: String(rows[0]!.id), name: '不应写入' })
      expect(duplicate).toMatchObject({ successful: false, executed: false })
      const persisted = await runtime.transaction(dataContext(ownerId), data => data.clients.list())
      expect(persisted[0]!.name).toBe('更新后联系人')
      expect(persisted[0]!.phone).toBe('67890')
      await runtime.transaction(dataContext(ownerId), async data => {
        await data.projects.create({ name: '正常项目' })
        await data.projects.create({ name: '归档项目', archived: true })
      })
      expect(await dispatch('list_projects', { archived: 'FaLsE' }))
        .toMatchObject({ successful: true, value: [expect.objectContaining({ name: '正常项目' })] })
      expect(await dispatch('list_projects', { archived: 'TRUE' }))
        .toMatchObject({ successful: true, value: [expect.objectContaining({ name: '归档项目' })] })
    } finally {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { vi } from 'vitest'
import { createProjectTool } from '../../../src/agent/tools/projects/index.js'

function containerDefinition(items: Record<string, any> = { type: 'object', properties: { label: { type: 'string' } } }): PreparedToolDefinition {
  return { name: 'test', schema: { type: 'function', function: { parameters: { type: 'object', properties: {
    array: { type: 'array', items }, object: { type: 'object', properties: { file_id: { type: 'integer' } } },
    mixed: { type: ['string', 'array'], items: { type: 'string' } },
  } } } } }
}

describe('有限容器兼容不替代Schema验证', () => {
  it('只按明确容器类型解析JSON字符串并递归归一，不改变原对象', () => {
    const input = { array: '[{"label":123}]', object: '{"file_id":"#7"}', mixed: '["保持文本"]' }
    expect(normalizeToolInput(containerDefinition(), input)).toEqual({ array: [{ label: '123' }], object: { file_id: 7 }, mixed: '["保持文本"]' })
    expect(input.array).toBe('[{"label":123}]')
    for (const array of ['{}', 'null', '42', 'true', '[错误JSON'])
      expect(normalizeToolInput(containerDefinition(), { array })).toEqual({ array })
  })
  it('array-only的item/block最多四层，支持数组、单对象和单标量', () => {
    const d = containerDefinition()
    const wrapped = { block: { item: { block: { item: [{ label: 123 }] } } } }
    expect(normalizeToolInput(d, { array: wrapped })).toEqual({ array: [{ label: '123' }] })
    expect(normalizeToolInput(d, { array: { item: { label: 123 } } })).toEqual({ array: [{ label: '123' }] })
    const strings = containerDefinition({ type: 'string' })
    expect(normalizeToolInput(strings, { array: { block: 123 } })).toEqual({ array: ['123'] })
    const five = { item: wrapped }
    expect(normalizeToolInput(d, { array: five })).toEqual({ array: five })
    expect(normalizeToolInput(d, { array: { item: null } })).toEqual({ array: { item: null } })
  })
  it('item/block是合法业务字段或未知多键形状时不拆包装', () => {
    const declared = containerDefinition({ type: 'object', properties: { item: { type: 'string' } } })
    expect(normalizeToolInput(declared, { array: { item: '业务正文' } })).toEqual({ array: { item: '业务正文' } })
    const union = containerDefinition({ anyOf: [{ type: 'string' }, { type: 'object', properties: { block: { type: 'string' } } }] })
    expect(normalizeToolInput(union, { array: { block: '业务正文' } })).toEqual({ array: { block: '业务正文' } })
    const unknown = { item: [], other: '额外字段' }
    expect(normalizeToolInput(containerDefinition(), { array: unknown })).toEqual({ array: unknown })
  })
  it('真实create_project registry端口接收stages及todos合法归一结构，不执行任何真实项目写入', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, project_id: 1, name: '容器项目' })
    const registry = createToolRegistry({ tools: [createProjectTool({ create })], authorize: async () => true })
    const scope: ToolScope = { identity: { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' },
      roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不得执行进程') } }
    const args = { project_name: '容器项目', start_date: '2026-01-01', deadline: '2026-02-01' }
    const dispatch = (stages: unknown) => registry.tools.dispatch({ id: 'call', name: 'create_project', input: { ...args, stages } }, scope)
    expect(await dispatch('[{"label":123,"todos":{"item":[456,"待办"]}},"交付"]')).toMatchObject({ successful: true })
    expect(create.mock.calls[0]![0]).toMatchObject({ args: { ...args, stages: [{ label: '123', todos: ['456', '待办'] }, '交付'] } })
    expect(await dispatch({ block: { label: '计划', todos: '["甲","乙"]' } })).toMatchObject({ successful: true })
    expect(create.mock.calls[1]![0]).toMatchObject({ args: { ...args, stages: [{ label: '计划', todos: ['甲', '乙'] }] } })
    for (const invalid of ['{"label":"不能误当数组"}', { item: { label: '缺字段', ownerId: '模型授权' } }, [{ todos: ['缺label'] }], { item: { item: { item: { item: { item: ['过深'] } } } } }])
      expect(await dispatch(invalid)).toMatchObject({ successful: false, executed: false })
    expect(create).toHaveBeenCalledTimes(2)
  })
  it('client_ids JSON数组归一后仍拒绝重复，真实存储不被修改', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-normalize-container-'))
    const path = join(root, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const registry = createToolRegistry({ tools: createClientTools(runtime), authorize: async () => true })
      const scope: ToolScope = { identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round', resolution: null,
        signal: new AbortController().signal, execute: async () => { throw new Error('不可执行命令') } }
      const client = await runtime.transaction(dataContext(ownerId), data => data.clients.create({ name: '小北' }))
      const result = await registry.tools.dispatch({ id: 'duplicate', name: 'update_client', input: {
        client_id: client.id, client_ids: `["${client.id}",${client.id}]`, notes: '不应写入',
      } }, scope)
      expect(result).toMatchObject({ successful: false, executed: false })
      const rows = await runtime.transaction(dataContext(ownerId), data => data.clients.list())
      expect(rows[0]!.notes).toBe('')
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  })
})

import { z } from 'zod'
import type { ToolDefinition } from '../../../src/agent/tools/contracts.js'

function strictArrayRegistry(strictArrayFields?: readonly string[]) {
  const item = z.object({ file_id: z.number().int(), enabled: z.boolean(), content: z.string(), tags: z.array(z.string()).optional() }).strict()
  const schema = z.object({ operations: z.array(item).optional(), box: z.object({ operations: z.array(item).optional() }).strict().optional() }).strict()
  const received: unknown[] = []
  const definition: ToolDefinition = {
    definition: { name: 'array_contract', schema: { type: 'function', function: { name: 'array_contract', parameters: z.toJSONSchema(schema) as Record<string, Json> } } },
    effect: 'write', strictArrayFields,
    validate: input => schema.safeParse(input),
    async execute(input) { received.push(structuredClone(input)); return { kind: 'completed', value: { stored: received.length }, successful: true, mutated: true } },
  }
  const registry = createToolRegistry({ tools: [definition], authorize: async () => true })
  const scope: ToolScope = { identity: { ownerId: 'synthetic-owner', sessionId: 'session', runId: 'run' }, roundId: 'round',
    signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不得执行进程') } }
  return { received, registry, definition, dispatch: (input: unknown) => registry.tools.dispatch({ id: 'call', name: 'array_contract', input }, scope) }
}
const arrayItem = { file_id: '#7', enabled: 'TRUE', content: 123 }
const canonicalItem = { file_id: 7, enabled: true, content: '123' }

describe('strictArrayFields元数据经过真实注册与调用', () => {
  it('默认未声明strict时解除item/block包装，逐字段归一且只执行一次', async () => {
    const f = strictArrayRegistry()
    const original = { operations: { block: { item: [arrayItem] } } }
    const saved = structuredClone(original)
    expect(await f.dispatch(original)).toMatchObject({ successful: true, mutated: true })
    expect(f.received).toEqual([{ operations: [canonicalItem] }])
    expect(original).toEqual(saved)
  })
  it.each(['item', 'block'])('strict根字段阻止%s包装解除，非法输入不执行', async wrapper => {
    const f = strictArrayRegistry(['operations'])
    expect(await f.dispatch({ operations: { [wrapper]: [arrayItem] } })).toMatchObject({ successful: false, executed: false })
    expect(f.received).toEqual([])
  })
  it('strict叶字段同时适用于嵌套object和数组item，不按完整路径误匹配', async () => {
    const f = strictArrayRegistry(['operations', 'tags'])
    expect(await f.dispatch({ box: { operations: { item: [arrayItem] } } })).toMatchObject({ successful: false, executed: false })
    expect(await f.dispatch({ operations: [{ ...arrayItem, tags: { block: ['甲'] } }] })).toMatchObject({ successful: false, executed: false })
    expect(f.received).toEqual([])
    const ordinary = strictArrayRegistry()
    expect(await ordinary.dispatch({ operations: [{ ...arrayItem, tags: { block: [456] } }] })).toMatchObject({ successful: true })
    expect(ordinary.received).toEqual([{ operations: [{ ...canonicalItem, tags: ['456'] }] }])
  })
  it('strict不阻止JSON数组文本或真实数组本身，仍递归执行标量兼容', async () => {
    const f = strictArrayRegistry(['operations', 'tags'])
    expect(await f.dispatch({ operations: JSON.stringify([arrayItem]) })).toMatchObject({ successful: true })
    expect(await f.dispatch({ box: { operations: JSON.stringify([arrayItem]) } })).toMatchObject({ successful: true })
    expect(await f.dispatch({ operations: [{ ...arrayItem, tags: '[123,"甲"]' }] })).toMatchObject({ successful: true })
    expect(f.received).toEqual([{ operations: [canonicalItem] }, { box: { operations: [canonicalItem] } }, { operations: [{ ...canonicalItem, tags: ['123', '甲'] }] }])
  })
  it('注册快照不受调用方后续修改strict数组影响', async () => {
    const strict = ['operations']
    const f = strictArrayRegistry(strict)
    strict.length = 0
    expect(await f.dispatch({ operations: { item: [arrayItem] } })).toMatchObject({ successful: false, executed: false })
    expect(f.received).toEqual([])
  })
  it.each([null, 'operations', [null], [12], [''], ['   ']])('strict元数据形状%j在注册期拒绝', strict => {
    expect(() => strictArrayRegistry(strict as unknown as readonly string[])).toThrow()
  })
})

describe('顶层拍平数组字段经过真实registry后仅无歧义修复', () => {
  it.each([undefined, null, '', '  ', '\u001c\u0085'])('容器缺失或空值%j时归并恰好属于item的字段并执行', async operations => {
    const f = strictArrayRegistry()
    const input = operations === undefined ? { ...arrayItem } : { operations, ...arrayItem }
    const saved = structuredClone(input)
    expect(await f.dispatch(input)).toMatchObject({ successful: true, mutated: true })
    expect(f.received).toEqual([{ operations: [canonicalItem] }])
    expect(input).toEqual(saved)
  })
  it.each([undefined, null, ' '])('strict容器%j禁止拍平修复，不执行副作用', async operations => {
    const f = strictArrayRegistry(['operations'])
    const input = operations === undefined ? { ...arrayItem } : { operations, ...arrayItem }
    expect(await f.dispatch(input)).toMatchObject({ successful: false, executed: false })
    expect(f.received).toEqual([])
  })
  it('存在未知多余键时不猜测搬运或丢弃字段', async () => {
    const f = strictArrayRegistry()
    expect(await f.dispatch({ ...arrayItem, unknown: '不得丢弃' })).toMatchObject({ successful: false, executed: false })
    expect(f.received).toEqual([])
  })
  it('已有真实数组时不合并顶层拍平字段，不修改原数组', async () => {
    const f = strictArrayRegistry()
    const input = { operations: [arrayItem], file_id: 99, enabled: false, content: '不能添加' }
    const saved = structuredClone(input)
    expect(await f.dispatch(input)).toMatchObject({ successful: false, executed: false })
    expect(input).toEqual(saved)
    expect(f.received).toEqual([])
    expect(await f.dispatch({ operations: [arrayItem] })).toMatchObject({ successful: true })
    expect(f.received).toEqual([{ operations: [canonicalItem] }])
  })
})

function decimalDigits(value: number | string, zero: number): string {
  return [...String(value)].map(character => String.fromCodePoint(zero + Number(character))).join('')
}

describe('Unicode Nd整数兼容经过真实registry与SQLite', () => {
  it('全角、阿拉伯、数学粗体和混合Nd ID更新真实联系人；非法与越权输入均不写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-unicode-id-'))
    const path = join(root, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const otherOwner = '00000000-0000-4000-8000-000000000002'
    const authorizedOwners = new Set([ownerId])
    try {
      // 先放合成记录以取得多位自增ID，目标联系人仍经过真实registry创建。
      await runtime.transaction(dataContext(ownerId), async data => {
        for (let index = 0; index < 10; index++) await data.clients.create({ name: `合成占位${index}` })
      })
      const registry = createToolRegistry({ tools: createClientTools(runtime), authorize: async identity => authorizedOwners.has(identity.ownerId) })
      const scope: ToolScope = { identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round', resolution: null,
        signal: new AbortController().signal, execute: async () => { throw new Error('不得执行进程') } }
      const made = await registry.tools.dispatch({ id: 'create-unicode', name: 'create_client', input: { client_name: 'Unicode联系人', notes: '初始备注' } }, scope)
      expect(made).toMatchObject({ successful: true, mutated: true })
      if (made.kind !== 'completed' || made.value === null || typeof made.value !== 'object' || !('contact_id' in made.value)) throw new Error('创建联系人未返回ID')
      const id = Number(made.value.contact_id)
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(String(id).length).toBeGreaterThan(1)
      const fullwidth = decimalDigits(id, 0xff10), arabic = decimalDigits(id, 0x0660), bold = decimalDigits(id, 0x1d7ce)
      const zeros = [0xff10, 0x0660, 0x1d7ce]
      const mixed = [...String(id)].map((character, index) => String.fromCodePoint(zeros[index % zeros.length]! + Number(character))).join('')
      const variants = [fullwidth, arabic, bold, mixed, `#${fullwidth}`, `#+${bold}`, `\u001c+${arabic}\u0085`]
      const readNotes = () => runtime.transaction(dataContext(ownerId), async data => (await data.clients.repository.get(id))!.notes)
      const update = (client_id: string, notes: string, owner = ownerId) => registry.tools.dispatch({ id: 'update-unicode', name: 'update_client', input: { client_id, notes } }, { ...scope, identity: { ...scope.identity, ownerId: owner } })
      for (const [index, client_id] of variants.entries()) {
        const note = `已更新${index}`
        expect(await update(client_id, note)).toMatchObject({ successful: true, mutated: true, value: { success: true, contact_id: id } })
        expect(await readNotes()).toBe(note)
      }
      const saved = await readNotes()
      const invalid = [decimalDigits('9007199254740992', 0xff10), `# ${fullwidth}`, '²', 'Ⅺ', `−${fullwidth}`, `﹣${arabic}`, `＋${bold}`,
        decimalDigits(id, 0x11de0), `#${decimalDigits(id, 0x11de0)}`,
        String(id).slice(0, -1) + String.fromCodePoint(0x11de0 + id % 10)]
      for (const client_id of invalid) {
        expect(await update(client_id, '不应写入')).toMatchObject({ successful: false, executed: false, mutated: false })
        expect(await readNotes()).toBe(saved)
      }
      expect(await update(fullwidth, '未授权不应写入', otherOwner)).toMatchObject({ successful: false, executed: false, mutated: false })
      expect(await readNotes()).toBe(saved)
      // 工具可用权限和资源ownership是独立边界：授权工具不允许更新别人的联系人。
      authorizedOwners.add(otherOwner)
      expect(await update(arabic, '越权不应写入', otherOwner)).toMatchObject({ successful: false, mutated: false })
      expect(await readNotes()).toBe(saved)
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  })
})

it('可选字段显式空值策略不改变必填、未声明策略或union，且不修改输入', () => {
  const tool = {name:'synthetic',schema:{type:'function',function:{parameters:{type:'object',required:['required'],properties:{
    optional:{type:'string','x-empty-string':'omit'}, required:{type:'string','x-empty-string':'omit'},
    array:{type:'array','x-empty-string':'empty-array'}, plain:{type:'string'},
    union:{type:['string','null'],'x-empty-string':'omit'},
  }}}}}
  const input={optional:'\u001c ',required:'',array:'',plain:'',union:''}
  expect(normalizeToolInput(tool,input)).toEqual({required:'',array:[],plain:'',union:''})
  expect(input).toEqual({optional:'\u001c ',required:'',array:'',plain:'',union:''})
})
