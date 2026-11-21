import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentInteractionHistory } from '../../../src/agent/sessions/interaction-history.js'

import { createSqliteInteractionActivator } from '../../../src/agent/interactions/sqlite-activate.js'
import { createSqliteInteractionProjection } from '../../../src/agent/interactions/sqlite-projection.js'
import { consumeSqliteInteraction, consumeSqliteInteractionChoice, consumeSqliteInteractionText } from '../../../src/agent/interactions/sqlite-consume.js'
import { createAgentInteractionDescription } from '../../../src/agent/interactions/prompt-description.js'

it('桌面交互提示绑定到运行，重复激活复用原选项且隔离其他 owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-interaction-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), date = new Date().toISOString()
      const identity = { ownerId, sessionId: '1', runId: 'synthetic-run' }
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
        VALUES (1,${owner},'合成会话',0,'','web',1,${date},${date})`.execute(runtime.db)
      await sql`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload)
        VALUES (${owner},1,${identity.runId},0,0,'running','tools',X'00',X'00')`.execute(runtime.db)
      const unsupported = async () => { throw new Error('测试不启用授权或凭据交互') }
      const shellCommand = `pwd\n# ${'x'.repeat(1500)}\npwd`
      const shellBody = `在桌面隔离目录内执行命令：\n${shellCommand}`
      const { activate } = createSqliteInteractionActivator(runtime.db, createAgentInteractionDescription({
        async confirmation() {
          return { kind: 'confirm', title: '请确认操作', body: shellBody, options: [], context: {} }
        },
        credential: unsupported, authorization: unsupported,
      }))
      const signal = new AbortController().signal
      const pending = { id: 'synthetic-prompt', kind: 'question' as const, toolCall: {
        id: 'synthetic-call', name: 'ask_user', input: { kind: 'question', title: '请选择', options: [{ id: 'a', label: '选项 A' }] },
      } }
      await expect(activate({ ...identity, ownerId: randomUUID() }, pending, signal)).rejects.toMatchObject({ code: 'conflict' })
      await activate(identity, pending, signal)
      await activate(identity, pending, signal)
      const rows = await createSqlAgentInteractionHistory(runtime.db, 'sqlite', () => new Date())(ownerId, 1, { restoreActive: true })
      expect(rows).toEqual([expect.objectContaining({ title: '请选择', tool_call_id: 'synthetic-call',
        options: [expect.objectContaining({ id: 'a', token: expect.any(String) }), expect.objectContaining({ id: '__custom_reply__' })] })])
      const projection = createSqliteInteractionProjection(runtime.db, 'synthetic-secret')
      const event = { identity, id: 'synthetic-event', sequence: 1, round: 1,
        type: 'interaction_required' as const, payload: { interactionId: pending.id } }
      const projected = await projection.interaction(event)
      expect(projected).toMatchObject({ type: 'interaction_required', prompt_id: rows[0]!.id,
        core_run_id: identity.runId, resolved: false, options: [expect.objectContaining({ id: 'a' }), expect.any(Object)] })
      expect(await projection.interaction(event)).toEqual(projected)
      await expect(projection.interaction({ ...event, identity: { ...identity, runId: 'wrong-run' } }))
        .rejects.toMatchObject({ code: 'not_found' })
      await sql`UPDATE agent_run_checkpoints SET status='waiting' WHERE run_id=${identity.runId}`.execute(runtime.db)
      const promptId = Number(projected.prompt_id)
      const [{ token }] = projected.options as Array<{ token: string }>
      await expect(consumeSqliteInteractionChoice(runtime.db, identity, promptId, 'wrong-token', 'synthetic-answer'))
        .rejects.toMatchObject({ code: 'action_invalid' })
      const answered = await consumeSqliteInteractionChoice(runtime.db, identity, promptId, token, 'synthetic-answer')
      expect(answered).toMatchObject({ awaitingText: false, resolution: {
        interactionId: pending.id, status: 'answered', value: { option_id: 'a', text: '选项 A' },
      } })
      expect(await consumeSqliteInteractionChoice(runtime.db, identity, promptId, token, 'synthetic-answer')).toEqual(answered)
      expect(await consumeSqliteInteraction(runtime.db, identity, promptId, null, '')).toEqual(answered)
      expect(await projection.interaction(event)).toMatchObject({ resolved: true, selected_option_id: 'a', options: [] })
      const textPrompt = { ...pending, id: 'synthetic-text-prompt' }
      await sql`UPDATE agent_run_checkpoints SET status='running' WHERE run_id=${identity.runId}`.execute(runtime.db)
      await activate(identity, textPrompt, signal)
      await sql`UPDATE agent_run_checkpoints SET status='waiting' WHERE run_id=${identity.runId}`.execute(runtime.db)
      const textEvent = { ...event, payload: { interactionId: textPrompt.id } }
      const textProjection = await projection.interaction(textEvent)
      const textPromptId = Number(textProjection.prompt_id)
      await expect(consumeSqliteInteraction(runtime.db, identity, promptId, null, '', { id: textPrompt.id, version: 0 }))
        .rejects.toMatchObject({ code: 'not_found' })
      await expect(consumeSqliteInteraction(runtime.db, identity, textPromptId, null, '', { id: textPrompt.id, version: 1 }))
        .rejects.toMatchObject({ code: 'not_found' })
      const answer = (text: string) => consumeSqliteInteractionText(runtime.db, identity, textPromptId, text, 'synthetic-text-answer')
      await expect(answer('合成回答')).rejects.toMatchObject({ code: 'custom_reply_must_be_selected' })
      const custom = (textProjection.options as Array<{ id: string; token: string }>).find(option => option.id === '__custom_reply__')!
      await expect(consumeSqliteInteractionChoice(runtime.db, identity, textPromptId, custom.token, 'synthetic-custom'))
        .resolves.toEqual({ resolution: null, awaitingText: true })
      const submitted = await answer(' 合成回答 ')
      expect(submitted).toMatchObject({ awaitingText: false, resolution: {
        interactionId: textPrompt.id, status: 'answered', value: { text: '合成回答' },
      } })
      expect(await answer('合成回答')).toEqual(submitted)
      await expect(answer('另一个合成回答')).rejects.toMatchObject({ code: 'conflict' })
      expect(await projection.interaction(textEvent)).toMatchObject({ resolved: true, response_text: '合成回答' })
      const shellPrompt = { id: 'synthetic-shell-prompt', kind: 'confirmation' as const, toolCall: {
        id: 'synthetic-shell-call', name: 'shell', input: { command: shellCommand },
      } }
      await sql`UPDATE agent_run_checkpoints SET status='running' WHERE run_id=${identity.runId}`.execute(runtime.db)
      await activate(identity, shellPrompt, signal)
      await expect(projection.interaction({ ...event, payload: { interactionId: shellPrompt.id } }))
        .resolves.toMatchObject({ body: shellBody })
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('MCP 密钥输入不返回选项令牌、不轮换哈希且不泄漏目标密文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-secret-history-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), date = '2026-01-01 00:00:00.000000'
      const schema = JSON.stringify({ secret_fields: [{ name: 'api_key' }], context: { secret_target: { kind: 'mcp_credentials', credential_value: 'synthetic-private' } } })
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'对话',0,'','web',1,${date},${date})`.execute(runtime.db)
      await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES (1,${owner},1,'form','凭据','',${schema},'active','2027-01-01 00:00:00',${date})`.execute(runtime.db)
      await sql`INSERT INTO interaction_actions(id,prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at) VALUES (1,1,'original-hash','mcp_secret_input','input_credentials','{}','pending','2027-01-01 00:00:00',${date})`.execute(runtime.db)
      const rows = await createSqlAgentInteractionHistory(runtime.db, 'sqlite', () => new Date('2026-01-02T00:00:00Z'))(ownerId, 1, { restoreActive: true })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.options).toEqual([])
      expect(JSON.stringify(rows)).not.toContain('synthetic-private')
      expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe('original-hash')
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('正式 SQLite 交互历史校验并归一时间，在事务提交后返回可用 token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-history-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), date = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'对话',0,'','web',1,${date},${date})`.execute(runtime.db)
      const active = JSON.stringify({ options: [{ id: 5, label: '' }], secret_fields: {}, context: { tool_call_id: 77, secret_target: { kind: 'mcp_credentials' } } })
      const legacy = JSON.stringify(JSON.stringify({ context: { tool_call_id: 'old' } }))
      await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES
        (1,${owner},1,'confirm','活动','',${active},'active','2026-01-01T08:00:02+08:00','2026-01-01T08:00:00.123456+08:00'),
        (2,${owner},1,'confirm','历史','',${legacy},'resolved','2026-01-01 00:00:00','2026-01-01 00:00:00.123456'),
        (3,${owner},1,'confirm','历史后','',${'{}'},'resolved','2026-01-01 00:00:00','2026-01-01 00:00:00.123457')`.execute(runtime.db)
      await sql`INSERT INTO interaction_actions(id,prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at) VALUES
        (1,1,'old','choice','5','{}','pending','2026-01-01T08:00:02+08:00',${date}),
        (3,1,'old','choice','other','{}','pending','2026-01-01 00:00:02',${date})`.execute(runtime.db)
      const list = createSqlAgentInteractionHistory(runtime.db, 'sqlite', () => new Date('2026-01-01T00:00:01Z'))
      const rows = await list(ownerId, 1, { restoreActive: true })
      expect(rows.map(row => row.id)).toEqual([1, 2, 3])
      expect(rows[0]?.tool_call_id).toBe('77'); expect(rows[0]?.options[0]?.label).toBe('')
      expect(rows[1]?.tool_call_id).toBe('old')
      const token = rows[0]!.options[0]!.token
      const saved = await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)
      expect(saved.rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(await list(randomUUID(), 1, { restoreActive: true })).toEqual([])
      const base = Date.parse('2026-01-01T00:00:00.123Z')
      expect((await list(ownerId, 1, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })).map(row => row.id)).toEqual([2])
      await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES
        (4,${owner},1,'confirm','数字','',${'{"context":{"tool_call_id":77}}'},'resolved',${date},${date}),
        (5,${owner},1,'confirm','字符串','',${'{"context":{"tool_call_id":"77"}}'},'resolved',${date},${date}),
        (6,${owner},1,'confirm','大数字','',${'{"context":{"tool_call_id":9007199254740993}}'},'resolved',${date},${date})`.execute(runtime.db)
      expect((await list(ownerId, 1, { restoreActive: false, toolCallIds: ['77'] })).map(row => row.id)).toEqual([5])
      expect(await list(ownerId, 1, { restoreActive: false, toolCallIds: ['9007199254740993'] })).toEqual([])
      expect((await list(ownerId, 1, { restoreActive: false })).find(row => row.id === 6)?.tool_call_id).toBe('9007199254740993')
      await sql`CREATE TRIGGER fail_history_token BEFORE UPDATE ON interaction_actions WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`.execute(runtime.db)
      await expect(list(ownerId, 1, { restoreActive: true })).rejects.toThrow()
      expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      await sql`DROP TRIGGER fail_history_token`.execute(runtime.db)
      const expiry = new Date(Date.now() + 500).toISOString()
      await sql`UPDATE interaction_prompts SET expires_at=${expiry} WHERE id=1`.execute(runtime.db)
      await sql`UPDATE interaction_actions SET expires_at=${expiry} WHERE prompt_id=1`.execute(runtime.db)
      const require = createRequire(import.meta.url)
      const expiryWorker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const db=new (require(workerData.sqlite))(workerData.path);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},800)`, { eval: true, workerData: { sqlite: require.resolve('better-sqlite3'), path } })
      try {
        await new Promise<void>((resolve, reject) => { expiryWorker.once('message', () => resolve()); expiryWorker.once('error', reject) })
        expect(Date.now()).toBeLessThan(Date.parse(expiry))
        const expired = (await createSqlAgentInteractionHistory(runtime.db, 'sqlite')(ownerId, 1, { restoreActive: false })).find(row => row.id === 1)
        expect(expired?.resolved).toBe(true); expect(expired?.options).toEqual([])
        expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      } finally { await expiryWorker.terminate() }
      await sql`UPDATE interaction_prompts SET expires_at='2026-01-01T08:00:02+08:00' WHERE id=1`.execute(runtime.db)
      await sql`UPDATE interaction_actions SET expires_at='2026-01-01 00:00:02' WHERE prompt_id=1`.execute(runtime.db)
      const workerCode = `const { parentPort,workerData }=require('node:worker_threads'); const SQLite=require(workerData.sqlite); const db=new SQLite(workerData.path); db.pragma('busy_timeout=5000'); db.exec("BEGIN IMMEDIATE; UPDATE interaction_prompts SET status='resolved' WHERE id=1"); parentPort.postMessage('locked'); setTimeout(()=>{db.exec('COMMIT');db.close();parentPort.postMessage('committed')},300)`
      const worker = new Worker(workerCode, { eval: true, workerData: { sqlite: require.resolve('better-sqlite3'), path } })
      try {
        await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject) })
        const start = Date.now(), afterConsume = await list(ownerId, 1, { restoreActive: true })
        expect(Date.now() - start).toBeGreaterThanOrEqual(100)
        expect(afterConsume.find(row => row.id === 1)?.resolved).toBe(true)
        expect(afterConsume.find(row => row.id === 1)?.options).toEqual([])
        expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      } finally { await worker.terminate() }
      await sql`UPDATE interaction_prompts SET created_at='not-a-time' WHERE id=3`.execute(runtime.db)
      await expect(list(ownerId, 1, { restoreActive: false })).rejects.toMatchObject({ code: 'storage_error', message: '交互时间格式无效' })
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
