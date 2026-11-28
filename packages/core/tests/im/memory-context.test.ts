import assert from 'node:assert/strict'
import { test } from 'vitest'
import { formatGroupMemory, formatPlatformUserMemory, snapshotImMemory } from '../../src/im/memory-context.js'
import { resolveImActor } from '../../src/im/access.js'

const input = { ownerId: 'owner-synthetic', botId: '7', platform: 'qq' as const, platformUserId: 'member-synthetic', chatType: 'group' as const, chatId: 'group-synthetic', botMentioned: true, mentionsOtherBot: false }
const groupActor = resolveImActor(input, () => ({ role: 'member', allowedToolNames: [] }))
const privateActor = resolveImActor({ ...input, chatType: 'c2c', chatId: null }, () => ({ role: 'member', allowedToolNames: [] }))

test('群与成员记忆分别格式化，群仅公开summary/profile', () => {
  const data = { group: { summary: '群内决定', profile: '产品讨论群', memory: '不应加载的长期记忆', ownersecret: '不应出现' }, platform_user: { summary: '成员摘要', profile: '成员自述做插画', pattern: '偏好短回复' } }
  assert.equal(formatGroupMemory(data), '## 当前群组记忆（仅限本群公开信息）\n\n### 群组 summary\n群内决定\n\n### 群组 profile\n产品讨论群')
  const personal = formatPlatformUserMemory(data)
  assert.ok(personal.includes('成员自述做插画'))
  assert.ok(personal.includes('偏好短回复'))
  assert.equal(personal.includes('群内决定'), false)
  assert.equal(formatGroupMemory(data).includes('长期记忆'), false)
})

test('每个来源最多50条，3000Unicode字符预算不截断emoji或扩大到标题长度', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ text: `画像${index}` }))
  const rendered = formatPlatformUserMemory({ platform_user: { profile: rows, pattern: rows.map((_, index) => ({ content: `模式${index}` })) } })
  for (const marker of ['画像0', '画像49', '模式0', '模式49']) assert.ok(rendered.includes(marker))
  for (const marker of ['画像50', '模式50']) assert.equal(rendered.includes(marker), false)
  const bounded = formatGroupMemory({ group: { summary: '🐦'.repeat(2999), profile: '尾巴超出' } })
  assert.ok(bounded.endsWith('### 群组 profile\n尾'))
  assert.equal(Array.from(bounded.match(/🐦+/u)![0]).length, 2999)
  assert.equal(bounded.includes('\ufffd'), false)
})

test('支持Python列表和text/content选择规则，不把JSON对象repr注入上下文', () => {
  const actual = formatGroupMemory({ group: { profile: [{ text: '画像一' }, { text: '', content: '画像二' }, '', null, true, 0] } })
  assert.ok(actual.endsWith('- 画像一\n- 画像二\n- None\n- True\n- 0'))
  assert.equal(formatGroupMemory({ group: { profile: { other: '不应出现' } } }), '')
  assert.equal(formatGroupMemory({ group: { profile: false, summary: 0 } }), '')
})

test('群snapshot不保存任何成员个人记忆或群长期字段，输出与输入脱离引用', () => {
  const data = { group: { summary: '群摘要', profile: [{ text: '公开画像', internal: '不应保存' }], memory: '不应保存', ownersecret: '不应保存' }, platform_user: { profile: '私人画像' } }
  const result = snapshotImMemory('基础快照', data, groupActor, true)
  assert.deepEqual(result.imMemory, { group: { summary: '群摘要', profile: [{ text: '公开画像' }] } })
  assert.equal(JSON.stringify(result).includes('私人画像'), false)
  assert.equal(JSON.stringify(result).includes('不应保存'), false)
  data.group.profile[0]!.text = '后来变更'
  assert.equal(JSON.stringify(result).includes('后来变更'), false)
})

test('受限私聊snapshot只保留当前成员scope，owner私聊不保存成员私人资料', () => {
  const data = { group: { summary: '另一个群' }, platform_user: { profile: '当前成员资料', pattern: '简短', memory: '不应保存' } }
  const member = snapshotImMemory('基础快照', data, privateActor, true)
  assert.ok(member.snapshotContext.includes('当前成员资料'))
  assert.equal(member.snapshotContext.includes('另一个群'), false)
  assert.deepEqual(member.imMemory, { platform_user: { profile: '当前成员资料', pattern: '简短' } })
  const owner = resolveImActor({ ...input, chatType: 'c2c', chatId: null }, () => ({ role: 'owner', allowedToolNames: null }))
  assert.deepEqual(snapshotImMemory('基础快照', data, owner, true), { snapshotContext: '基础快照', imMemory: { platform_user: {} } })
})

test('owner记忆开关显式传入，不擅自改变旧IM scope授权语义', () => {
  const data = { group: { summary: '已按群开关授权的摘要' } }
  assert.deepEqual(snapshotImMemory('', data, groupActor, false), snapshotImMemory('', data, groupActor, true))
  assert.throws(() => snapshotImMemory('', data, groupActor, undefined as unknown as boolean))
})

test('空scope不添加正文，损坏形状静态拒绝且不暴露原始内容', () => {
  assert.equal(formatGroupMemory(null), '')
  assert.equal(formatPlatformUserMemory({}), '')
  assert.deepEqual(snapshotImMemory('基础', {}, groupActor, true), { snapshotContext: '基础', imMemory: { group: {} } })
  for (const data of [[], { group: '秘密原文' }, { group: { profile: [['秘密原文']] } }, { group: { summary: { text: { secret: '秘密原文' } } } }])
    assert.throws(() => formatGroupMemory(data), error => error instanceof TypeError && !error.message.includes('秘密原文'))
})
