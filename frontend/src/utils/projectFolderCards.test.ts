import { describe, it, expect } from 'vitest'
import { statusFolders, yearFolders, monthFolders } from './projectFolderCards'

// 等价护栏：断言与 loadContents 抽出前逐字一致。
const KANBAN = [
  { key: 'pending', label: '待开始' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' },
]

describe('statusFolders', () => {
  it('按状态计数，空组不显示，顺序随 kanbanColumns', () => {
    const projects = [
      { status: 'active' }, { status: 'active' }, { status: 'done' },
    ]
    expect(statusFolders(projects, KANBAN)).toEqual([
      { id: 'st:active', type: 'status', status: 'active', displayName: '进行中', count: 2 },
      { id: 'st:done', type: 'status', status: 'done', displayName: '已完成', count: 1 },
    ])
  })
  it('全空 → 空数组', () => {
    expect(statusFolders([], KANBAN)).toEqual([])
  })
})

describe('yearFolders', () => {
  it('只统计 done，按完成年份计数，年份降序', () => {
    const projects = [
      { status: 'done', doneAt: '2026-07-01' },
      { status: 'done', doneAt: '2025-03-01' },
      { status: 'done', doneAt: '2026-01-15' },
      { status: 'active', doneAt: '2024-01-01' }, // 非 done，忽略
    ]
    expect(yearFolders(projects)).toEqual([
      { id: 'y:2026', type: 'year', displayName: '2026 年', year: '2026', count: 2 },
      { id: 'y:2025', type: 'year', displayName: '2025 年', year: '2025', count: 1 },
    ])
  })
})

describe('monthFolders', () => {
  it('某年 done 项目按完成月份计数，月份升序', () => {
    const projects = [
      { status: 'done', doneAt: '2026-07-01' },
      { status: 'done', doneAt: '2026-03-20' },
      { status: 'done', doneAt: '2026-07-15' },
      { status: 'done', doneAt: '2025-07-01' }, // 别的年份，忽略
    ]
    expect(monthFolders(projects, '2026')).toEqual([
      { id: 'm:2026-03', type: 'month', displayName: '3 月', year: '2026', month: '03', count: 1 },
      { id: 'm:2026-07', type: 'month', displayName: '7 月', year: '2026', month: '07', count: 2 },
    ])
  })
  it('该年无 done → 空数组', () => {
    expect(monthFolders([{ status: 'done', doneAt: '2025-01-01' }], '2026')).toEqual([])
  })
})
