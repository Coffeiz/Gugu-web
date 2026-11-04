import { describe, expect, it } from 'vitest'
import { resolveMonitorSelection } from '../../../loopscope/frontend/src/utils/monitorSelection'

describe('LoopScope run monitor selection', () => {
  it('活动 run 刷新列表时保留用户正在查看的旧 run', () => {
    expect(resolveMonitorSelection({
      runIds: ['active-run', 'older-run'],
      selectedRunId: 'older-run',
      focusRunId: 'active-run',
      focusChanged: false,
    })).toBe('older-run')
  })

  it('显式焦点变化时切到目标 run', () => {
    expect(resolveMonitorSelection({
      runIds: ['new-run', 'older-run'],
      selectedRunId: 'older-run',
      focusRunId: 'new-run',
      focusChanged: true,
    })).toBe('new-run')
  })

  it('当前选择从列表移除后回到最新可用 run', () => {
    expect(resolveMonitorSelection({
      runIds: ['latest-run', 'other-run'],
      selectedRunId: 'removed-run',
      focusRunId: 'active-run',
      focusChanged: false,
    })).toBe('latest-run')
  })
})
