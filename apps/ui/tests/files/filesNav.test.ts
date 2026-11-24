// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { navPathFor, type NavSeg, type FolderCard } from '@/utils/filesNav'

// 等价护栏：断言与 enterFolder 抽出前逐字一致。只钉「当前合法路径」语义；
// 异常路径（如 month 卡但当前无 year 段）的防御另开一刀，这里不覆盖。

const card = (o: Partial<FolderCard> & { type: string }): FolderCard =>
  ({ id: 'x', displayName: 'D', count: null, ...o })

describe('navPathFor — 根入口切换', () => {
  it('personal', () => {
    expect(navPathFor(card({ type: 'personal' }), [])).toEqual([{ type: 'personal', name: '个人文件', color: null }])
  })
  it('projects', () => {
    expect(navPathFor(card({ type: 'projects' }), [])).toEqual([{ type: 'projects', name: '项目文件', color: null }])
  })
  it('trash', () => {
    expect(navPathFor(card({ type: 'trash' }), [])).toEqual([{ type: 'trash', name: '回收站', color: null }])
  })
  it('未知 type → 原样返回当前路径', () => {
    const cur: NavSeg[] = [{ type: 'personal', name: '个人文件' }]
    expect(navPathFor(card({ type: '???' }), cur)).toBe(cur)
  })
})

describe('navPathFor — 项目层级归档', () => {
  it('status → [项目, 状态]', () => {
    expect(navPathFor(card({ type: 'status', status: 'active', displayName: '进行中' }), [])).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'active', name: '进行中', color: null },
    ])
  })
  it('year → [项目, 已完成, 年]', () => {
    expect(navPathFor(card({ type: 'year', year: '2026' }), [])).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2026 年', year: '2026', color: null },
    ])
  })
  it('month → year 段取自当前路径的 year 段，month 段 year/month 取自卡片', () => {
    const cur: NavSeg[] = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2026 年', year: '2026', color: null },
    ]
    expect(navPathFor(card({ type: 'month', month: '07', year: '2026' }), cur)).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2026 年', year: '2026', color: null },
      { type: 'month', name: '7 月', year: '2026', month: '07', color: null },
    ])
  })
  it('month 但当前路径缺 year 段（异常/搜索跳转）→ 退用卡片自带 year，不崩', () => {
    expect(navPathFor(card({ type: 'month', month: '03', year: '2025' }), [])).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2025 年', year: '2025', color: null },
      { type: 'month', name: '3 月', year: '2025', month: '03', color: null },
    ])
  })
})

describe('navPathFor — project 卡保留 status/year/month 上下文', () => {
  it('已在 已完成/年/月 下点项目 → 保留三段再追加 project', () => {
    const cur: NavSeg[] = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2026 年', year: '2026', color: null },
      { type: 'month', name: '7 月', year: '2026', month: '07', color: null },
    ]
    expect(navPathFor(card({ type: 'project', projectId: 5, displayName: 'P', color: '#abc' }), cur)).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: '2026 年', year: '2026', color: null },
      { type: 'month', name: '7 月', year: '2026', month: '07', color: null },
      { type: 'project', id: 5, name: 'P', color: '#abc' },
    ])
  })
  it('无上下文点项目 → [项目, project]', () => {
    expect(navPathFor(card({ type: 'project', projectId: 9, displayName: 'Q', color: '#def' }), [])).toEqual([
      { type: 'projects', name: '项目文件', color: null },
      { type: 'project', id: 9, name: 'Q', color: '#def' },
    ])
  })
})

describe('navPathFor — 磁盘目录按相对路径导航', () => {
  it('个人文件中的嵌套目录保留路径层级，不依赖目录数据库 ID', () => {
    const current: NavSeg[] = [{ type: 'disk-personal', name: '个人文件', relativePath: '资料' }]
    expect(navPathFor(card({ type: 'disk-personal', id: '资料/图片', displayName: '图片', relativePath: '资料/图片' }), current)).toEqual([
      { type: 'disk-personal', name: '个人文件', relativePath: '资料' },
      { type: 'disk-personal', name: '图片', relativePath: '资料/图片', workspaceDirectoryId: undefined },
    ])
  })
})
