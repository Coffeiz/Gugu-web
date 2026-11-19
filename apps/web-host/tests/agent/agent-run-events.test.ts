import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunEvent } from '@gugu/core/agent'
import { projectAgentRunEvent } from '../../src/modules/agent/run/events.js'

const identity = { ownerId: 'synthetic-owner', sessionId: '1', runId: 'run-1' }
function event(type: RunEvent['type'], payload: Record<string, unknown>): RunEvent {
  return { id: 'event-1', identity, sequence: 1, round: 2, type, payload }
}
const ports = { interaction: async () => ({ type: 'interaction_required', prompt_id: 42, options: [] }) }

test('流式投影保留显示顺序，不公开诊断及未授权内部字段', async () => {
  const display = { kind: 'assistant', text: '你好', eventId: 'item-1' }
  assert.deepEqual(await projectAgentRunEvent(event('token', { display, secret: 'private' }), ports), [{ type: 'display_event', item: display }])
  assert.deepEqual(await projectAgentRunEvent(event('provider_diagnostic', { secret: 'private' }), ports), [])
  assert.deepEqual(await projectAgentRunEvent(event('round_start', {}), ports), [{ type: 'round_start', run_id: 'run-1', round_id: 'run-1:2' }])
})

test('交互通过授权服务投影，取消与失败保留不同终态', async () => {
  assert.deepEqual(await projectAgentRunEvent(event('interaction_required', { interactionId: 'i', secret: 'private' }), ports), [{ type: 'interaction_required', prompt_id: 42, options: [] }])
  assert.deepEqual(await projectAgentRunEvent(event('final', { status: 'cancelled', remoteStatusUnknown: true }), ports), [{ type: 'done', run_id: 'run-1', cancelled: true, remote_status_unknown: true }])
  assert.deepEqual(await projectAgentRunEvent(event('final', { status: 'failed', text: '模型不可用' }), ports), [{ type: 'error', message: '模型不可用' }, { type: 'done', run_id: 'run-1', cancelled: false, remote_status_unknown: false }])
})

test('未知执行结果仍在结束事件之前关闭原工具卡片', async () => {
  const tool = { kind: 'tool', eventId: 'tool-1', toolStatus: 'stopped' }
  assert.deepEqual(await projectAgentRunEvent(event('final', {
    status: 'unknown', remoteStatusUnknown: true, text: '执行结果尚未确认', sealedTools: [tool],
  }), ports), [
    { type: 'display_event', item: tool },
    { type: 'error', message: '执行结果尚未确认' },
    { type: 'done', run_id: 'run-1', cancelled: false, remote_status_unknown: true },
  ])
})
