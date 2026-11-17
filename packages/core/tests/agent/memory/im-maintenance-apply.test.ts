import assert from 'node:assert/strict'
import test from 'node:test'
import { applyImMaintenanceOutput, mergeImMaintenanceOutputs } from '../../../src/memory/im-maintenance-apply.js'

test('group maintenance removes similar public profile entries and rejects member identifiers', () => {
  const result = applyImMaintenanceOutput({
    scopeType: 'group', now: 99,
    current: { profile: [
      { type: 'rule', text: '每周例会定在周一', ts: 1 },
      { type: 'unsupported', text: '不应保留为群公开资料', ts: 2 },
      { type: 'nature', text: '成员 platform_user_id=private 不应写入', ts: 2 },
    ], daily: '## 2026-01-01\n- 旧记录\n' },
    output: { profile_remove: ['每周例会定在周一'], profile_add: [
      { type: 'project', text: '每周例会定在周一', ts: 3 },
      { type: 'member', text: '群成员个人经历' },
      { type: 'rule', text: '群规：禁止泄露 user_openid=secret' },
    ], summary: '群摘要', daily: ['新记录'] },
    date: '2026-01-02',
  })
  assert.deepEqual(result.profile, [{ type: 'project', text: '每周例会定在周一', ts: 99 }])
  assert.deepEqual(result.summary, { text: '群摘要', ts: 99 })
  assert.equal(result.daily, '## 2026-01-02\n- 新记录\n\n## 2026-01-01\n- 旧记录\n')
})

test('member maintenance merges profile and patterns, keeps only recent daily entries', () => {
  const daily = `## 2026-01-01\n${Array.from({ length: 51 }, (_, index) => `- 记录${index}`).join('\n')}\n`
  const result = applyImMaintenanceOutput({
    scopeType: 'platform-user', now: 100, date: '2026-01-02',
    current: {
      profile: [{ type: 'note', text: '喜欢猫', ts: 1 }],
      pattern: [{ text: '常在清晨跑步', kind: 'observed', importance: 2 }],
      daily,
    },
    output: {
      profile: [{ type: 'preference', text: '喜欢猫咪' }, { type: 'unsupported', text: '丢弃' }],
      pattern: [{ text: '常在清晨跑步', kind: 'inferred', importance: 3 }, { text: '新增习惯', importance: 0 }],
      daily: '今天去公园',
    },
  })
  assert.deepEqual(result.profile, [
    { type: 'note', text: '喜欢猫', ts: 1 },
    { type: 'preference', text: '喜欢猫咪', ts: 100 },
    { type: 'note', text: '丢弃', ts: 100 },
  ])
  assert.deepEqual(result.pattern, [
    { text: '常在清晨跑步', kind: 'observed', importance: 2 },
    { text: '新增习惯', kind: 'observed', importance: 1 },
  ])
  assert.equal(result.daily?.split('\n').filter(line => line.startsWith('- ')).length, 50)
  assert.match(result.daily ?? '', /## 2026-01-02\n- 今天去公园/)
})

test('group nickname updates preserve the Python members document and do not create new members', () => {
  const result = applyImMaintenanceOutput({
    scopeType: 'group', now: 100, date: '2026-01-01',
    current: { members: { updated_at: 1, members: { existing: { nicknames: ['小北'] } } } },
    output: { nicknames_add: [
      { platform_user_id: 'existing', nickname: '小北' },
      { platform_user_id: 'existing', nickname: '北北' },
      { platform_user_id: 'unknown', nickname: '不应创建' },
    ] },
  })
  assert.deepEqual(result.members, { updated_at: 100, members: { existing: { nicknames: ['小北', '北北'] } } })
})

test('preview batches merge incremental fields and merge members by stable platform id', () => {
  assert.deepEqual(mergeImMaintenanceOutputs([
    { facts: ['第一批'], summary: '旧摘要', members: [{ platform_user_id: 'u1', profile: ['旧画像'], count: 1 }] },
    { facts: ['第二批'], summary: '', members: [
      { platform_user_id: 'u1', profile: ['新画像'], count: 0 },
      { profile: ['缺 ID，忽略'] },
    ] },
  ]), {
    facts: ['第一批', '第二批'],
    summary: '旧摘要',
    members: [{ platform_user_id: 'u1', profile: ['旧画像', '新画像'], count: 1 }],
  })
})
