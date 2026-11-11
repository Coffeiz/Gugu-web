import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { prepareClientFields, prepareProjectCreate, normalizeProjectStages, replaceProjectStages } from '../src/domain/index.js'
import { utc } from '../src/data/codec.js'
import { requestJsonSchema } from '../src/contracts/index.js'

describe('领域输入与可移植边界', () => {
  it('按 Unicode 码点限制联系人长度，保留空值和未经 trim 的名称', () => {
    expect(prepareClientFields({ name: '😀'.repeat(200), phone: null }, true).phone).toBeNull()
    expect(() => prepareClientFields({ name: '😀'.repeat(201) }, true)).toThrow('长度')
    expect(prepareClientFields({ name: ' 小北 ', notes: '' }, true)).toEqual({ name: ' 小北 ', notes: '' })
    expect(() => prepareClientFields({ name: '  ' }, true)).toThrow('不能为空')
    expect(() => prepareClientFields({ name: '小北', owner_id: 'other' }, true)).toThrow()
  })
  it('拒绝非法日期、状态引用及把布尔值冒充进度', () => {
    expect(() => prepareProjectCreate({ name: '计划', deadline: '2026-02-29' })).toThrow('YYYY-MM-DD')
    expect(() => prepareProjectCreate({ name: '计划', start_date: '2026-11-12', deadline: '2026-11-11' })).toThrow('不能晚于')
    expect(() => prepareProjectCreate({ name: '计划', current_stage: 's0' })).toThrow('阶段列表')
    expect(() => prepareProjectCreate({ name: '计划', progress: true })).toThrow('整数')
    expect(() => prepareProjectCreate({ name: '😀'.repeat(201) })).toThrow('200')
    expect(() => normalizeProjectStages([{ label: '准备', todos: null }])).toThrow()
    expect(prepareProjectCreate({ name: '计划', summary: '  ', progress: 0, archived: false })).toMatchObject({ summary: null, progress: 0, archived: false })
  })
  it('阶段重排与改名保留待办身份，显式替换才生成新编号', () => {
    const old = normalizeProjectStages([{ label: '准备', todos: ['整理'] }, { label: '完成' }])
    old[0]!.todos![0]!.done = true
    const [renamed, current] = replaceProjectStages(old, 's0', [{ key: 's1', label: '归档' }, { key: 's0', label: '启动' }])
    expect(current).toBe('s0'); expect(renamed[1]!.todos).toEqual([{ id: 't1', text: '整理', done: true }])
    expect(replaceProjectStages(old, 's0', [{ key: 's0', label: '准备', todos: ['重新整理'] }])[0][0]!.todos![0]!.id).toBe('t2')
    expect(() => replaceProjectStages(old, null, [{ key: 's0', label: '重复' }, { key: 's0', label: '重复' }])).toThrow('重复')
  })
  it('数据库 UTC 转换保留微秒，不依赖宿主时区', () => {
    expect(utc('2026-11-11 00:00:01.123456+09:00')).toBe('2026-11-10 15:00:01.123456+00:00')
    expect(utc('2026-11-10 15:00:01.000000')).toBe('2026-11-10 15:00:01+00:00')
    expect(utc('2026-11-10T15:00:01.001Z')).toBe('2026-11-10 15:00:01.001000+00:00')
    expect(() => utc('2026-02-30 10:00:00')).toThrow('格式无效')
  })
  it('可移植目录不依赖 Node、SQL 或宿主，协议可生成 JSON Schema', () => {
    for (const directory of ['domain', 'contracts']) {
      for (const name of readdirSync(new URL(`../src/${directory}/`, import.meta.url)).filter(name => name.endsWith('.ts'))) {
        const source = ts.createSourceFile(name, readFileSync(new URL(`../src/${directory}/${name}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
        const imports = source.statements.filter(ts.isImportDeclaration).map(item => (item.moduleSpecifier as ts.StringLiteral).text)
        expect(imports.filter(item => /^(node:|kysely|pg$|better-sqlite3)|\/(data|runtime|application)\//.test(item))).toEqual([])
      }
    }
    expect(requestJsonSchema).toMatchObject({ type: 'object', additionalProperties: false })
  })
})
