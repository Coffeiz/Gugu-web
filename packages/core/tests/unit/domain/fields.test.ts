import { describe, expect, it } from 'vitest'
import {
  prepareClientFields,
  prepareProjectCreate,
  normalizeProjectStages,
  replaceProjectStages,
} from '../../../src/domain/index.js'

describe('Python 字段契约的边界回归', () => {
  it.each([
    [{ name: '小北', contact: null, email: null, phone: null, notes: '' }, true],
    [{ email: null, phone: '' }, false],
    [
      {
        name: '😀'.repeat(200),
        contact: '合'.repeat(200),
        email: 'a'.repeat(300),
        phone: '1'.repeat(50),
      },
      true,
    ],
  ])('联系人保留合法边界和显式空值 %#', (input, creating) => {
    expect(prepareClientFields(input, creating)).toEqual(input)
  })
  it.each([
    {},
    { name: null },
    { name: '\u3000' },
    { name: '😀'.repeat(201) },
    { name: '小北', notes: null },
    { name: '小北', phone: 123 },
    { name: '小北', contact: 'x'.repeat(201) },
    { name: '小北', email: 'x'.repeat(301) },
    { name: '小北', phone: '1'.repeat(51) },
    { name: '小北', owner_id: '不可覆盖' },
  ])('联系人拒绝非法字段且不改输入 %#', (input) => {
    const before = structuredClone(input)
    expect(() => prepareClientFields(input, true)).toThrow()
    expect(input).toEqual(before)
  })
  it.each([
    {
      name: '合法计划',
      summary: '  摘要  ',
      start_date: '2024-02-29',
      deadline: '2024-02-29',
      progress: 100,
      archived: false,
      priority: null,
    },
    {
      name: '😀'.repeat(200),
      summary: null,
      client: null,
      start_date: null,
      deadline: null,
      progress: 0,
    },
  ])('项目合法日期、Unicode 和空值可保留 %#', (input) => {
    expect(prepareProjectCreate(input)).toEqual({
      ...input,
      ...('summary' in input && input.summary ? { summary: '摘要' } : {}),
    })
  })
  it.each([
    {},
    { name: '' },
    { name: '非法/目录' },
    { name: 'x'.repeat(201) },
    { name: '计划', summary: 'x'.repeat(201) },
    { name: '计划', status: 'unknown' },
    { name: '计划', progress: -1 },
    { name: '计划', progress: 101 },
    { name: '计划', progress: 1.5 },
    { name: '计划', archived: 1 },
    { name: '计划', start_date: '2025-02-29' },
    { name: '计划', start_date: '2026-02-02', deadline: '2026-02-01' },
    { name: '计划', priority: 'urgent' },
    { name: '计划', current_stage: 'missing' },
    { name: '计划', user_id: '不可覆盖' },
  ])('项目拒绝非法状态/日期/字段且不改输入 %#', (input) => {
    const before = structuredClone(input)
    expect(() => prepareProjectCreate(input)).toThrow()
    expect(input).toEqual(before)
  })
  it('阶段重排保留当前阶段和待办身份，非法替换不修改旧状态', () => {
    const old = normalizeProjectStages([{ label: '准备', todos: ['确认'] }, '交付']),
      before = structuredClone(old)
    const [stages, current] = replaceProjectStages(old, 's1', [
      { key: 's1', label: '新交付' },
      { key: 's0', label: '新准备' },
    ])
    expect(current).toBe('s1')
    expect(stages[1]!.todos).toEqual([{ id: 't1', text: '确认', done: false }])
    expect(() =>
      replaceProjectStages(old, 's1', [{ key: 's99', label: '非法引用' }]),
    ).toThrow()
    expect(old).toEqual(before)
  })
})
