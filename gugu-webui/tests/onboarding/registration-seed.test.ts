import assert from 'node:assert/strict'
import test from 'node:test'
import { createRegistrationSeeder, type RegistrationSeedPlan, type RegistrationSeedPorts } from '../../src/domains/onboarding/registration-seed.js'

function fixture(overrides: Partial<RegistrationSeedPorts> = {}) {
  const applied: Array<{ ownerId: string; plan: RegistrationSeedPlan }> = []
  const ports: RegistrationSeedPorts = {
    async applySeed(ownerId, plan) { applied.push({ ownerId, plan }); return 'applied' },
    async surpriseMp3() { return null },
    ...overrides,
  }
  return { applied, ports }
}

test('生成完整注册计划并一次提交，包含本地化阶段、首日活动和两个项目文件', async () => {
  const { applied, ports } = fixture()
  await createRegistrationSeeder(ports, {
    now: () => new Date(2026, 10, 14, 12),
    random: () => 0,
  })('owner-synthetic', 'en-US')

  assert.equal(applied.length, 1)
  const { ownerId, plan } = applied[0]!
  assert.equal(ownerId, 'owner-synthetic')
  assert.deepEqual(plan.project, {
    name: 'Start here', status: 'active', currentStage: 's0',
    startDate: '2026-11-14', deadline: '2026-11-17',
    stages: [
      { key: 's0', label: '🌱 Still open', todos: [{ id: 's0t0', text: 'Take a look around', done: false }, { id: 's0t1', text: 'Try creating a project', done: false }] },
      { key: 's1', label: '🌿 Taking shape', todos: [{ id: 's1t0', text: 'Check the calendar', done: false }, { id: 's1t1', text: 'Check the file library', done: false }] },
      { key: 's2', label: '💬 Come chat with me', todos: [{ id: 's2t0', text: 'I’m in the bottom-right 😊', done: false }, { id: 's2t1', text: 'Add me on QQ (Feishu works too 📪)', done: false }] },
    ],
  })
  assert.deepEqual(plan.calendarEvent, { title: 'Our first day together', date: '2026-11-14', type: 'event' })
  assert.deepEqual(plan.files.map((file) => [file.space, file.projectRef, file.displayName, file.ext, file.mimeType]), [
    ['project', 'seed_project', 'To my future self', 'md', 'text/markdown'],
    ['project', 'seed_project', 'You can delete me', 'md', 'text/markdown'],
  ])
  assert.match(Buffer.from(plan.files[0]!.data).toString('utf8'), /To my future self/)
  assert.deepEqual(plan.seedState, { seeded: true, project_name: 'Start here' })
  assert.deepEqual(plan.guideState, { enabled: true, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null })
})

test('未知语言回退中文，随机边界值稳定选择首尾内容', async () => {
  const { applied, ports } = fixture()
  await createRegistrationSeeder(ports, { now: () => new Date(2026, 0, 2), random: () => -1 })('owner-synthetic', 'fr-FR')
  assert.equal(applied[0]!.plan.project.name, '从这里开始')
  assert.equal(applied[0]!.plan.calendarEvent.title, '和咕咕的第一天')
  assert.equal(applied[0]!.plan.project.startDate, '2026-01-02')
  assert.equal(applied[0]!.plan.project.deadline, '2026-01-05')

  const last = fixture()
  await createRegistrationSeeder(last.ports, { random: () => 1 })('owner-synthetic', null)
  assert.equal(last.applied[0]!.plan.project.name, '初次见面')
})

test('素材存在时计划包含个人 MP3，不存在时只计划两份项目文件', async () => {
  const withAsset = fixture({ async surpriseMp3() { return { name: 'synthetic-surprise', data: Buffer.from('mp3') } } })
  await createRegistrationSeeder(withAsset.ports, { random: () => 0 })('owner-synthetic', 'ja-JP')
  const plan = withAsset.applied[0]!.plan
  assert.equal(plan.project.name, 'ここから始める')
  assert.equal(plan.files.length, 3)
  assert.deepEqual(plan.files[2] && [plan.files[2].space, plan.files[2].projectRef, plan.files[2].displayName, plan.files[2].ext, plan.files[2].mimeType],
    ['personal', null, 'synthetic-surprise', 'mp3', 'audio/mpeg'])

  const withoutAsset = fixture()
  await createRegistrationSeeder(withoutAsset.ports, { random: () => 0 })('owner-synthetic')
  assert.equal(withoutAsset.applied[0]!.plan.files.length, 2)
})

test('原子端口失败不影响已提交的注册调用方，诊断回调失败也不外溢', async () => {
  const { applied, ports } = fixture({
    async applySeed(ownerId, plan) { applied.push({ ownerId, plan }); throw new Error('synthetic transaction failure') },
    onFailure() { throw new Error('diagnostic unavailable') },
  })
  await assert.doesNotReject(createRegistrationSeeder(ports)('owner-synthetic'))
  assert.equal(applied.length, 1)
})
