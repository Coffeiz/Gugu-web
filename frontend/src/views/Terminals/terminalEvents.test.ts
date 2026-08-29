import { describe, expect, it } from 'vitest'
import { replaceOrAppendTerminalEvent, type TerminalEventView } from './terminalEvents'

const event = (overrides: Partial<TerminalEventView>): TerminalEventView => ({
  sequence: 1, type: 'command', source: null, command: 'printf ok', stdout: '', stderr: '', exitCode: 0,
  occurredAt: '2026-08-29T00:00:00Z', runId: 'run-1', ...overrides,
})

describe('终端事件合并', () => {
  it('把状态占位、流式输出和最终事件合并为一条记录', () => {
    const items: TerminalEventView[] = []
    replaceOrAppendTerminalEvent(items, event({ type: 'status', stdout: 'running', sequence: 2, exitCode: null }))
    replaceOrAppendTerminalEvent(items, event({ type: 'output', stdout: 'o', sequence: 0, exitCode: null }))
    replaceOrAppendTerminalEvent(items, event({ stdout: 'ok', sequence: 3 }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ stdout: 'ok', sequence: 3 })
  })

  it('重复收到最终事件时不追加重复记录，并标记取消', () => {
    const items: TerminalEventView[] = [event({ state: 'running', sequence: 2, exitCode: null })]
    replaceOrAppendTerminalEvent(items, event({ stderr: '命令已取消', exitCode: null, sequence: 3 }))
    replaceOrAppendTerminalEvent(items, event({ stderr: '命令已取消', exitCode: null, sequence: 3 }))
    expect(items).toHaveLength(1)
    expect(items[0].state).toBe('cancelled')
  })
})
