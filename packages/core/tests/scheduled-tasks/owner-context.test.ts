import { describe, expect, it } from 'vitest'
import { createWebAgentContextBuilder, type ContextDataPorts } from '../../src/agent/index.js'
import { createScheduledTaskContextLoader } from '../../src/agent/scenes/task/owner-context.js'

const identity = { ownerId: 'owner', sessionId: 'scheduled-task:7', runId: 'run' }
const task = { id: '7', ownerId: 'owner', payload: '查询本周项目进度' }
const model = { modelIdentity: 'model', contextWindow: 8192, accessScopeHash: 'scope' }

function fixture(memoryEnabled = true, group = false) {
  const reads: string[] = []
  const queries: string[] = []
  function source<T>(name: string, value: T) {
    return async ({ ownerId, sessionId }: { ownerId: string; sessionId: string }) => {
      expect({ ownerId, sessionId }).toEqual({ ownerId: identity.ownerId, sessionId: identity.sessionId })
      reads.push(name)
      return value
    }
  }
  const data: ContextDataPorts = {
    loadTimezone: source('timezone', 'Asia/Shanghai'),
    loadProjects: source('projects', [{ name: '本人的项目' }]),
    loadEvents: source('calendar', [{ date: '2026-01-01', title: '本人的日历' }]),
    loadNotes: source('notes', [{ title: '不应读取的笔记' }]),
    loadFilesOverview: source('files', { total: 1, files: [{ name: '本人文件.txt' }] }),
    loadStylePreferences: source('style', { custom_reply_style: '本人的风格' }),
    async loadMemory(target, _signal, query) {
      queries.push(query ?? '')
      return source('memory', { profile: '本人的记忆' })(target)
    },
    loadImChannels: source('channels', { qq: true }),
    loadImMemory: source('im-memory', { profile: '不应从会话读取的群资料' }),
    loadKnowledge: source('knowledge', []),
  }
  const now = () => Date.parse('2026-01-01T08:00:00Z')
  const builder = createWebAgentContextBuilder({
    now,
    staticPrompt(_selection, _identity, style) {
      return { base: '基础提示词', persona: '', skills: '', policy: '', skillIndex: '',
        timezone: 'Asia/Shanghai', now: new Date(now()), afterBasePrompt: JSON.stringify(style) }
    },
    sessionInfo: () => ({}),
    systemInMessages: () => false,
  }, null, { includeScopedContext: true })
  const load = createScheduledTaskContextLoader({
    data, builder, now, memoryEnabled, identity, model, prompt: '本次定时任务',
    loadGroupStyle: source('group-style', { group_personality_preference: '本群专用风格' }),
    task: group ? { ...task, groupScope: { ownerId: task.ownerId, platform: 'qq', botId: '1', scopeType: 'group', scopeId: '群一' } } : task,
  })
  return { load, reads, queries }
}

describe('定时任务 owner 上下文', () => {
  it('读取 owner 业务数据，保留一次性投递指令且不加载会话或笔记', async () => {
    const { load, reads, queries } = fixture()
    const result = await load(identity, new AbortController().signal)
    const { input, ...binding } = result
    expect(binding).toEqual(model)
    expect(result).not.toHaveProperty('sourceEffects')
    expect(input).toMatchObject({ ownerId: 'owner', sessionId: 'scheduled-task:7', history: [],
      entryKind: 'scheduled_task', userTimezone: 'Asia/Shanghai',
      currentUser: { message: { role: 'user', content: '本次定时任务' } } })
    expect(input.currentUser?.persistedMessageId).toBeUndefined()
    expect(input.systemPrompt).toContain('本人的风格')
    expect(input.fixedPrefix.map(message => message.content).join('\n')).toContain('一次性给出完整回复')
    expect(input.extraReminder).toContain('16:00')
    for (const text of ['本人的项目', '本人的日历', '本人文件.txt', '本人的记忆'])
      expect(input.snapshotText).toContain(text)
    expect(queries).toEqual([task.payload])
    expect([...reads].sort()).toEqual(['calendar', 'channels', 'files', 'knowledge', 'memory', 'projects', 'style', 'timezone'])
  })

  it('拒绝其他 owner、任务或尝试身份及取消的请求，不读取数据', async () => {
    const { load, reads } = fixture()
    const signal = new AbortController().signal
    for (const mismatch of [{ ownerId: 'other' }, { sessionId: 'scheduled-task:8' }, { runId: 'other' }])
      await expect(load({ ...identity, ...mismatch }, signal)).rejects.toThrow('定时任务上下文身份不匹配')
    await expect(load(identity, AbortSignal.abort())).rejects.toHaveProperty('name', 'AbortError')
    expect(reads).toEqual([])
  })

  it('群投递关闭个人记忆、偏好和业务资料读取', async () => {
    const { load, reads } = fixture(true, true)
    const { input } = await load(identity, new AbortController().signal)
    expect(input.snapshotText).not.toContain('本人的记忆')
    expect(input.systemPrompt).not.toContain('本人的风格')
    expect(input.systemPrompt).toContain('本群专用风格')
    expect(input.snapshotText).toContain('QQ：已连')
    expect(reads).toEqual(['timezone', 'group-style'])
  })

  it('关闭长期记忆时跳过记忆读取', async () => {
    const { load, reads } = fixture(false)
    const result = await load(identity, new AbortController().signal)
    expect(result.input.snapshotText).not.toContain('本人的记忆')
    expect(reads).not.toContain('memory')
  })
})
