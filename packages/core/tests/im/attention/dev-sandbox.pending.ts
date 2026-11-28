import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionDefaults, scoreAttentionSandbox } from '../../../src/im/attention/dev-sandbox.js'

test('注意力沙盒遵循生产阈值且不返回消息正文', () => {
  assert.deepEqual(attentionDefaults(), {
    algorithm_version: 'attention-v3.0.7',
    thresholds: { quiet: 85, natural: 65, active: 55 },
    topic_ttl_seconds: 600,
    topic_half_life_seconds: 360,
    member_active_ttl_seconds: 180,
  })
  const result = scoreAttentionSandbox({ anchor_text: '翻个跟斗——来了，落地了', text: '他哪会翻跟斗', gap_seconds: 124 }, 1_800_000_000_000)
  assert.equal(result.state, 'TOPIC')
  assert.equal(result.kind, 'PROACTIVE')
  assert.ok(Math.abs(result.score - 68.34) < 0.2)
  assert.ok(!JSON.stringify(result).includes('翻个跟斗'))
})

test('成员主动窗口在180秒过期且感谢不触发回复', () => {
  assert.equal(scoreAttentionSandbox({ text: '改成明天吧', member_active_age_seconds: 179 }, 1_800_000_000_000).kind, 'MEMBER_ACTIVE')
  assert.equal(scoreAttentionSandbox({ text: '改成明天吧', member_active_age_seconds: 180 }, 1_800_000_000_000).kind, 'PASSIVE')
  assert.equal(scoreAttentionSandbox({ text: '谢谢', member_active_age_seconds: 20 }, 1_800_000_000_000).kind, 'PASSIVE')
})
