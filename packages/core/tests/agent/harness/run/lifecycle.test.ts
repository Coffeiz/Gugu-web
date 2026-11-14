import { expect,it } from 'vitest'
import type { RunStatus } from '../../../../src/agent/harness/contracts.js'
import { assertRunTransition } from '../../../../src/agent/harness/run/lifecycle.js'

it.each(['completed', 'cancelled', 'failed', 'unknown'] as const)('终态%s不能被迟到回调重新打开', status => {
  expect(() => assertRunTransition(status, 'running')).toThrow('运行状态转换无效')
  expect(() => assertRunTransition(status, status)).not.toThrow()
})

it.each([
  ['preparing', 'running'], ['preparing', 'completed'], ['running', 'waiting'],
  ['waiting', 'running'], ['running', 'cancelled'], ['waiting', 'failed'],
] satisfies [RunStatus, RunStatus][])('允许正常准备、等待、恢复和收尾：%s→%s', (previous, next) => {
  expect(() => assertRunTransition(previous, next)).not.toThrow()
})

it.each([['preparing', 'waiting'], ['running', 'preparing'], ['waiting', 'preparing']] satisfies [RunStatus, RunStatus][])(
  '拒绝绕过准备或倒退状态：%s→%s', (previous, next) => {
    expect(() => assertRunTransition(previous, next)).toThrow('运行状态转换无效')
  },
)
