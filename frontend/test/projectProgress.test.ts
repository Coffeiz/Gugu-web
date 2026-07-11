import { describe, it, expect } from 'vitest'
import { projectProgress } from '@/utils/projectProgress'

// 全站统一进度口径（看板 / 总览 / 项目卡 / 日历 / Dashboard 都用它）。
// 主口径：所有阶段待办的 已完成/总数；无任何待办时兜底按当前阶段位置。钉死这两条分支。

const stage = (key: string, todos: Array<{ done: boolean }> = []) => ({ key, todos })

describe('projectProgress — 待办占比（主口径）', () => {
  it('跨阶段汇总 已完成/总数', () => {
    const project = { stages: [
      stage('a', [{ done: true }, { done: false }]),
      stage('b', [{ done: true }, { done: true }]),
    ] }
    expect(projectProgress(project)).toBe(75)   // 3/4
  })
  it('四舍五入', () => {
    expect(projectProgress({ stages: [stage('a', [{ done: true }, { done: false }, { done: false }])] })).toBe(33)  // 1/3
  })
  it('部分阶段没待办也只按总待办算（total>0 就不兜底）', () => {
    const project = { stages: [stage('a', [{ done: true }]), stage('b')] }
    expect(projectProgress(project)).toBe(100)   // 1/1
  })
})

describe('projectProgress — 阶段位置兜底（无任何待办）', () => {
  it('按 (当前阶段序号+1)/阶段数', () => {
    const project = { stages: [stage('a'), stage('b'), stage('c')], currentStage: 'b' }
    expect(projectProgress(project)).toBe(67)   // (1+1)/3
  })
  it('currentStage 不存在 → 0', () => {
    expect(projectProgress({ stages: [stage('a'), stage('b')], currentStage: 'x' })).toBe(0)
  })
})

describe('projectProgress — 边界', () => {
  it('无阶段 → 0', () => {
    expect(projectProgress({ stages: [] })).toBe(0)
    expect(projectProgress({})).toBe(0)
    expect(projectProgress(null)).toBe(0)
  })
})
