import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCurrentDate, buildAgentStaticPrompt } from '@gugu/core/agent'

test('静态提示按用户时区和明确偏好组装，不把分钟时间放入前缀', () => {
  const now = new Date('2026-01-01T16:30:00Z')
  assert.equal(agentCurrentDate(now, 'Asia/Shanghai'), '2026-01-02（星期五）')
  const value = buildAgentStaticPrompt({ base: '日期 {today}\n---旧段落', persona: '默认人格', skills: '技能协议', policy: '安全原则', skillIndex: '技能索引', locale: 'ja-JP', personalityPreferenceEnabled: true, personalityPreference: '偏好人格', customReplyStyleEnabled: true, customReplyStyle: '简洁', timezone: 'Asia/Shanghai', now })
  assert.match(value, /^日期 2026-01-02（星期五）/); assert.match(value, /日本語/); assert.match(value, /偏好人格/); assert.match(value, /安全原则/)
  assert.equal(value.includes('默认人格'), false); assert.equal(value.includes('旧段落'), false); assert.equal(value.includes('00:30'), false)
})
