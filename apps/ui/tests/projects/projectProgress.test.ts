// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { projectProgress } from '@/utils/projectProgress'
import { calculateStageProgress } from '@/composables/projects/useProjectProgress'

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
  it('跨阶段三条待办完成两条时四舍五入为 67%', () => {
    expect(projectProgress({ stages: [stage('a', [{ done: true }, { done: false }]), stage('b', [{ done: true }])] })).toBe(67)
  })
  it('展示进度保留全部待办口径，阶段保存仍使用当前阶段口径', () => {
    const stages = [
      { key: 'a', label: '计划', todos: [{ id: 'a1', text: '甲', done: false }, { id: 'a2', text: '乙', done: false }] },
      { key: 'b', label: '交付', todos: [{ id: 'b1', text: '丙', done: true }, { id: 'b2', text: '丁', done: false }] },
    ]
    expect(projectProgress({ stages, currentStage: 'b' })).toBe(25)
    expect(calculateStageProgress(stages, 'b')).toBe(75)
  })
})

describe('projectProgress — 阶段位置兜底（无任何待办）', () => {
  it.each([[40, 22, 58, 57], [72, 26, 37, 38]])('保留 %s 阶段第 %s 项的头部与卡片原有舍入结果', (count, index, header, card) => {
    const stages = Array.from({ length: count }, (_, i) => ({ key: `s${i}`, label: '阶段', todos: [] }))
    const currentStage = stages[index].key
    expect(projectProgress({ stages, currentStage })).toBe(card)
    expect(projectProgress({ stages, currentStage }, () => calculateStageProgress(stages, currentStage))).toBe(header)
  })

  it('按 (当前阶段序号+1)/阶段数', () => {
    const project = { stages: [stage('a'), stage('b'), stage('c')], currentStage: 'b' }
    expect(projectProgress(project)).toBe(67)   // (1+1)/3
  })
  it('currentStage 不存在 → 0', () => {
    expect(projectProgress({ stages: [stage('a'), stage('b')], currentStage: 'x' })).toBe(0)
  })
  it('无待办时到最后阶段显示 100%', () => {
    expect(projectProgress({ stages: [stage('a'), stage('b')], currentStage: 'b' })).toBe(100)
  })
})

describe('projectProgress — 边界', () => {
  it('无阶段 → 0', () => {
    expect(projectProgress({ stages: [] })).toBe(0)
    expect(projectProgress({})).toBe(0)
    expect(projectProgress(null)).toBe(0)
  })
})
