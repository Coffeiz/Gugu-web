import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createLocalPreferenceTextFiles } from '../../../src/preferences/text-files.js'
import { desktopAgentPreference } from '../../../src/preferences/desktop-agent.js'
import { createKyselyPreferenceDocumentStore } from '../../../src/preferences/document-store.js'
import { readSqliteAgentOverviewData, readSqliteAgentStylePreferences, formatSqliteAgentOverview } from '../../../src/agent/context/sqlite-overview.js'

describe('Desktop SQLite Agent 上下文来源', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  it('新 Run 读取 owner 项目、日历、近期笔记并生成共享 Core 快照', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-sqlite-overview-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const owner = ownerId.replaceAll('-', ''), runId = randomUUID()
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '')
    await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,active_run_id,created_at,updated_at)
      VALUES (1,${owner},'Desktop chat',0,'','web',1,${runId},${stamp},${stamp})`.execute(runtime.db)
    await sql`INSERT INTO projects(user_id,name,status,priority,stages_json,archived,color,progress,version,created_at,updated_at)
      VALUES (${owner},'本地上下文项目','active','high','[{"done":true},{"done":false}]',0,'',0,1,${stamp},${stamp})`.execute(runtime.db)
    await sql`INSERT INTO calendar_events(user_id,title,date,type,version,created_at)
      VALUES (${owner},'本地日历事项','2099-01-02','event',1,${stamp})`.execute(runtime.db)
    await sql`INSERT INTO mind_nodes(user_id,kind,title,content_plain,content_md,origin,version,captured_at,created_at,updated_at)
      VALUES (${owner},'note','本地笔记','近期笔记正文','近期笔记正文','manual',1,${stamp},${stamp},${stamp})`.execute(runtime.db)
    const identity = { ownerId, sessionId: '1', runId }

    const data = await readSqliteAgentOverviewData(runtime.db, identity, 'UTC', new AbortController().signal)
    expect(data.projects).toEqual([expect.objectContaining({ name: '本地上下文项目', stagesDone: 1, stagesTotal: 2 })])
    expect(data.events).toEqual([expect.objectContaining({ title: '本地日历事项' })])
    expect(data.notes).toEqual([expect.objectContaining({ title: '本地笔记', content: '近期笔记正文' })])
    expect(formatSqliteAgentOverview(data, '记忆内容')).toContain('本地上下文项目')
    expect(formatSqliteAgentOverview(data, '记忆内容')).toContain('记忆内容')
    await expect(readSqliteAgentOverviewData(runtime.db, { ...identity, runId: randomUUID() }, 'UTC', new AbortController().signal))
      .rejects.toThrow('本机会话上下文不存在')
  })

  it('读取与 Web 相同的 owner 回复风格设置，并拒绝非当前 Run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-sqlite-style-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const owner = ownerId.replaceAll('-', ''), runId = randomUUID()
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '')
    await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,active_run_id,created_at,updated_at)
      VALUES (1,${owner},'Desktop chat',0,'','web',1,${runId},${stamp},${stamp})`.execute(runtime.db)
    await sql`INSERT INTO user_preferences(user_id,data_json,updated_at)
      VALUES (${owner},${JSON.stringify({ custom_reply_style_enabled: true, custom_reply_style: '简洁、直说', locale: 'zh-CN' })},${stamp})`.execute(runtime.db)
    const identity = { ownerId, sessionId: '1', runId }

    await expect(readSqliteAgentStylePreferences(runtime.db, identity, new AbortController().signal)).resolves.toEqual({
      custom_reply_style_enabled: true,
      custom_reply_style: '简洁、直说',
      locale: 'zh-CN',
      personality_preference_enabled: false,
      personality_preference_revision: 0,
    })
    const files = createLocalPreferenceTextFiles(directory)
    const store = createKyselyPreferenceDocumentStore(runtime.db, 'sqlite')
    await expect(desktopAgentPreference(store, files, ownerId, 'reply-style'))
      .resolves.toMatchObject({ content: '简洁、直说', enabled: true })
    await desktopAgentPreference(store, files, ownerId, 'personality', { content: '私人设定', enabled: true })
    await desktopAgentPreference(store, files, ownerId, 'group-personality', { content: '群聊设定', enabled: true })
    await desktopAgentPreference(store, files, ownerId, 'reply-style', { content: '只使用短句' })
    expect(await readFile(join(directory, ownerId, '.agent', 'prompt', 'persona.md'), 'utf8')).toBe('私人设定')
    const signal = new AbortController().signal
    const personal = await readSqliteAgentStylePreferences(runtime.db, identity, signal, files)
    expect(personal).toMatchObject({ personality_preference: '私人设定', custom_reply_style: '只使用短句' })
    expect(personal).not.toHaveProperty('group_personality_preference')
    await expect(readSqliteAgentStylePreferences(runtime.db, identity, signal, files, true)).resolves.toEqual({
      group_personality_preference_enabled: true, group_personality_preference: '群聊设定',
    })
    await desktopAgentPreference(store, files, ownerId, 'personality', { enabled: false })
    const disabled = await readSqliteAgentStylePreferences(runtime.db, identity, signal, files)
    expect(disabled.personality_preference_enabled).toBe(false)
    expect(disabled).not.toHaveProperty('personality_preference')
    await expect(readSqliteAgentStylePreferences(runtime.db, { ...identity, runId: randomUUID() }, signal, files))
      .rejects.toThrow('本机会话上下文不存在')
  })
})
