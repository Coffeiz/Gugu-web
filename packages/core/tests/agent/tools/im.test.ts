import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentGroupHistory, createSqlAgentOwnerSessionBindings } from '../../../src/agent/sessions/im-tools.js'
import { expect, it, vi } from 'vitest'
import { createAgentImTools } from '../../../src/agent/tools/im.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
const context = { identity, roundId: 'round-a', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('不执行 Shell') } }
const registry = (ports: Parameters<typeof createAgentImTools>[0]) =>
  createToolRegistry({ tools: createAgentImTools(ports), authorize: async candidate => candidate.ownerId === identity.ownerId })
const dispatch = (reg: ReturnType<typeof registry>, name: string, input: Record<string, unknown>) =>
  reg.tools.dispatch({ id: 'call-a', name, input }, context)

it('表情回应只使用可信飞书消息坐标，失去平台授权后不能发送', async () => {
  const target = { platform: 'feishu' as const, channelId: 'bot-a', messageId: 'message-a' }
  let available = true
  const send = vi.fn(async () => 'sent' as const)
  const reg = registry({ reaction: { target: async () => available ? target : null, react: send } })
  expect(await dispatch(reg, 'react', { mood: 'love', messageId: 'forged' })).toMatchObject({ successful: false })
  expect(send).not.toHaveBeenCalled()
  expect(await dispatch(reg, 'react', { mood: 'love' })).toMatchObject({ value: { ok: true }, mutated: true })
  expect(send).toHaveBeenCalledWith(identity, target, 'HEART', context.signal)
  available = false
  expect(await dispatch(reg, 'react', { mood: 'laugh' })).toMatchObject({ value: { ok: false }, mutated: false })
  expect(send).toHaveBeenCalledTimes(1)
})

it('只为可信 owner 私聊绑定会话，并保留异主与非 Web 目标的拒绝结果', async () => {
  const owner = { role: 'owner' as const, chatType: 'c2c' as const, platform: 'qq', platformUserId: 'private-a' }
  let available = true
  const bind = vi.fn(async (_identity: unknown, _owner: unknown, id: number) => id === 5 ? 'bound' as const : 'not_found' as const)
  const reg = registry({ ownerSession: { privateOwner: async () => available ? owner : null, bind } })
  expect(await dispatch(reg, 'bind_web_session', { session_id: 5 })).toMatchObject({ value: { bound: true, session_id: 5 } })
  expect(bind).toHaveBeenCalledWith(identity, owner, 5, context.signal)
  expect(await dispatch(reg, 'bind_web_session', { session_id: 6 })).toMatchObject({ value: { error: '网页会话不存在、不属于你，或不是 Web 会话' } })
  available = false
  expect(await dispatch(reg, 'bind_web_session', { session_id: 5 })).toMatchObject({ successful: false })
  expect(bind).toHaveBeenCalledTimes(2)
})

it('群搜索将精确曾用名优先于实时昵称的模糊匹配，并将查询限定在可信群', async () => {
  const scope = { platform: 'telegram' as const, botId: 'bot-a', chatId: 'group-a' }
  const search = vi.fn(async () => [
    { role: 'assistant', content: '新回复', platform_user_id: null, platform_user_name: null },
    { role: 'user', content: '部署计划', platform_user_id: 'old', platform_user_name: '小东' },
  ])
  const members = vi.fn(async () => ({ old: { aliases: ['小北'] } }))
  const reg = registry({ group: {
    scope: async () => scope,
    speakers: async () => [{ id: 'fuzzy', name: '小北哥', lastSeen: 21 }],
    members, search,
  } })
  expect(await dispatch(reg, 'group_context_search', { keyword: ' 部署 计划 ', speaker: '小北', limit: 200 })).toMatchObject({
    value: { queries: ['部署 计划'], speaker_id: 'old', messages: [
      { role: '用户', content: '部署计划', platform_user_id: 'old', platform_user_name: '小东' },
      { role: '咕咕', content: '新回复' },
    ] },
  })
  expect(search).toHaveBeenCalledWith(identity, scope, { queries: ['部署 计划'], mode: 'OR', speakerId: 'old', limit: 30 }, context.signal)
  await dispatch(reg, 'group_context_search', { speaker: 'fuzzy' })
  expect(members).toHaveBeenCalledTimes(1)
  expect(await dispatch(reg, 'group_context_search', { chatId: 'forged' })).toMatchObject({ successful: false })
  expect(search).toHaveBeenCalledTimes(2)
})

it('SQLite 群历史限定平台、机器人、群和 owner，绑定只接受 owner 的 Web 会话', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'gugu-agent-im-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(temporary, 'im.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const current = { ...identity, ownerId: opened.ownerId }
    const foreign = { ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }
    const time = '2026-01-01 00:00:00.000000'
    const channels = [
      ['telegram', 'bot-a', 'chat-a'], ['telegram', 'bot-b', 'chat-a'],
      ['qq', 'bot-a', 'chat-a'], ['telegram', 'bot-a', 'chat-b'], ['web', null, null],
    ] as const
    for (const [index, [source, bot, chat]] of channels.entries()) {
      const id = index + 1
      await sql`INSERT INTO conversation_sessions
        (id,user_id,title,title_locked,summary,source,bot_id,chat_id,chat_type,context_epoch,created_at,updated_at)
        VALUES (${id},${owner},'对话',0,'',${source},${bot},${chat},${chat ? 'group' : null},0,${time},${time})
      `.execute(runtime.db)
      await sql`INSERT INTO conversation_messages
        (session_id,conversation_seq,role,content,platform_user_id,platform_user_name,created_at)
        VALUES (${id},1,'user',${'部署 ' + id},${'user-' + id},'小北',${time})
      `.execute(runtime.db)
    }
    const history = createSqlAgentGroupHistory(runtime.db, 'sqlite')
    const scope = { platform: 'telegram' as const, botId: 'bot-a', chatId: 'chat-a' }
    const query = { queries: ['部署'], mode: 'OR' as const, limit: 10, speakerId: null }
    expect(await history.search(current, scope, query, context.signal)).toEqual([
      { role: 'user', content: '部署 1', platform_user_id: 'user-1', platform_user_name: '小北' },
    ])
    expect(await history.search(foreign, scope, query, context.signal)).toEqual([])
    expect((await history.speakers(current, scope, context.signal)).map(item => item.id)).toEqual(['user-1'])
    const setBinding = vi.fn(async () => 'bound' as const)
    const privateOwner = { role: 'owner' as const, chatType: 'c2c' as const, platform: 'qq', platformUserId: 'synthetic' }
    const { bind, readWebSession } = createSqlAgentOwnerSessionBindings(runtime.db, 'sqlite', {
      setBinding, async getBinding() { return '5' },
    }, async () => privateOwner)
    expect(await bind(foreign, privateOwner, 5, context.signal)).toBe('not_found')
    expect(await bind(current, privateOwner, 1, context.signal)).toBe('not_found')
    expect(await bind(current, privateOwner, 5, context.signal)).toBe('bound')
    expect(setBinding).toHaveBeenCalledTimes(1)
    expect(setBinding).toHaveBeenCalledWith(`im:owner-session:${opened.ownerId}:qq:synthetic`, '5', 43200, context.signal)
    expect(await readWebSession(current.ownerId, privateOwner, context.signal)).toBe(5)
    expect(await readWebSession(foreign.ownerId, privateOwner, context.signal)).toBeNull()
  } finally {
    await runtime?.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
