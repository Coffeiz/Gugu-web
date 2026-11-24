import { createWorkspaceFileReads } from '../../../../src/modules/workspaces/files.js'
import { parseWorkspaceFileReference } from '../../../../src/modules/agent/context/references.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { startServer } from '../../../../src/main.js'
import { applyAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applyInteractionActionsMigration } from '@gugu/database/postgres/migrations/0008_interaction_actions'
import { applyAgentRunMigration } from '@gugu/database/postgres/migrations/0003_agent_run'
import { imGateway } from '@gugu/database/postgres/migrations/0013_im_gateway'
import { providerCredentials } from '@gugu/database/postgres/migrations/0016_provider_credentials'
import { byokBindings } from '@gugu/database/postgres/migrations/0021_byok_bindings'
import { scheduledTaskMode } from '@gugu/database/postgres/migrations/0022_scheduled_task_mode'
import { applyWebDomainMigration } from '@gugu/database/postgres/migrations/0002_web_domain'
import { applyFilesystemAuthorizationMigration } from '@gugu/database/postgres/migrations/0005_filesystem_authorization'
import { subagentDeliveries } from '@gugu/database/postgres/migrations/0028_subagent_deliveries'
import { subagentSessions } from '@gugu/database/postgres/migrations/0029_subagent_sessions'
import { subagentLaunches } from '@gugu/database/postgres/migrations/0030_subagent_launches'
import { subagentWaits } from '@gugu/database/postgres/migrations/0031_subagent_waits'
import { subagentContinuations } from '@gugu/database/postgres/migrations/0034_subagent_continuations'
import { subagentExecutions } from '@gugu/database/postgres/migrations/0035_subagent_executions'
import { subagentConversations } from '@gugu/database/postgres/migrations/0033_subagent_conversations'
import { agentInbox } from '@gugu/database/postgres/migrations/0032_agent_inbox'

async function waitFor(condition: () => Promise<boolean>, signal: AbortSignal, describe: () => string) {
  try {
    while (!await condition()) await delay(50, undefined, { signal })
  } catch (error) {
    if (signal.aborted) throw new Error(describe(), { cause: error })
    throw error
  }
}


const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const shellRootfs = process.env.GUGU_BUBBLEWRAP_TEST_ROOTFS

for (const mode of ['子终态唤醒原父 Run', '跨父运行续聊', '父取消经 Redis 停止子 Run', '进程重启续跑原子 Run', '授权文件搜索与读取', '授权工作区路径引用', '自动模式使用父工作区 Shell', '普通模式经父会话确认 Shell'] as const) {
  const workspaceMode = mode === '授权工作区路径引用'
  const confirmShell = mode === '普通模式经父会话确认 Shell'
  const shellMode = mode === '自动模式使用父工作区 Shell' || confirmShell
  const skip = !(pgUrl && redisUrl)
    ? '需要隔离 PostgreSQL 和 Redis'
    : shellMode && (!shellRootfs || process.platform !== 'linux') ? '需要 Linux 和隔离根目录'
      : workspaceMode && process.platform !== 'linux' && '工作区锚定文件读取需要 Linux'
  test(`Web 生产入口派单 Searcher，${mode}`, {
    skip, timeout: 50_000,
  }, async () => {
    const schema = `searcher_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: pgUrl })
    const url = new URL(pgUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: url.toString() })
    const root = await mkdtemp(join(tmpdir(), 'gugu-web-searcher-'))
    const fileMode = mode === '授权文件搜索与读取' || workspaceMode
    let fileId: number | string
    let excludedFileId: number | string
    let fileKey: string
    let excludedFileKey: string
    let parentRequests = 0
    let childStreamClosed = false
    let childStreamStarted = false
    const cancellation = mode === '父取消经 Redis 停止子 Run'
    const restart = mode === '进程重启续跑原子 Run'
    let childRequests = 0
    let followupRequests = 0
    let followupReplies = 0
    let webProcess: ChildProcess | undefined
    let gate: PoolClient | undefined
    async function stopProcess() {
      const child = webProcess
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    let host: Awaited<ReturnType<typeof startServer>> | undefined
    const provider = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString('utf8')
        const { stream, tools } = JSON.parse(body) as { stream?: boolean; tools?: Array<{ function?: { name?: string } }> }
        if (stream && body.includes('合成委派专用请求')) {
          const child = body.includes('你是 Searcher')
          if (!child) parentRequests++
          const final = '已完成合成 Searcher 结果'
          let choice
          if (child && body.includes('继续核对前一份合成结果')) {
            followupRequests++
            assert.match(body, /已完成合成 Searcher 结果/u)
            assert.match(body, /合成委派专用请求/u)
            assert.doesNotMatch(body, /父会话专属后续提问/u)
            choice = { delta: { content: '合成子会话续聊完成' }, finish_reason: 'stop' }
          } else if (child) {
            assert.ok(tools?.some(tool => tool.function?.name === "shell"), "Searcher 缺少 Shell meta tool")
            assert.ok(!tools?.some(tool => tool.function?.name === "read_file"), "Searcher 暴露了退役工具")
            childRequests++
            if (cancellation) {
              childStreamStarted = true
              response.on('close', () => { childStreamClosed = true })
              response.writeHead(200, { 'content-type': 'text/event-stream' })
              response.flushHeaders()
              response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '合成取消前的子内容' } }] })}\n\n`)
              return
            }
            await waitFor(async () => (await pool.query('SELECT 1 FROM agent_subagent_waits LIMIT 1')).rows.length > 0,
              AbortSignal.timeout(5000), () => '父 Run 未进入等待')
            if (fileMode && childRequests <= 3) {
              if (childRequests === 2 && (!body.includes('合成授权文件.txt') || body.includes('合成排除文件.txt')))
                throw new Error('搜索没有限制在委派范围')
              if (childRequests === 3 && !body.includes('文件不存在或无权访问')) throw new Error('未拒绝越权读取')
              const ref = workspaceMode ? (childRequests === 2 ? excludedFileKey : fileKey)
                : (childRequests === 2 ? excludedFileId : fileId)
              choice = { delta: { tool_calls: [{ index: 0, id: `synthetic-file-${childRequests}`, type: 'function',
                function: { name: childRequests === 1 ? 'global_search' : 'shell',
                  arguments: JSON.stringify(childRequests === 1 ? { query: '文件' }
                    : { command: 'cat -- ' + ref }) } }] },
              finish_reason: 'tool_calls' }
            } else if (shellMode && childRequests === 1) {
              choice = { delta: { tool_calls: [{ index: 0, id: 'synthetic-shell', type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: "printf '合成共享结果' > synthetic-searcher.txt; cat synthetic-searcher.txt" }) } }] },
              finish_reason: 'tool_calls' }
            } else {
              if (shellMode && !body.includes('合成共享结果')) throw new Error('子 Shell 没有返回工作区结果')
              if (fileMode && (!body.includes('合成授权文件正文') || body.includes('合成排除文件正文')))
                throw new Error('读取正文与授权不一致')
              choice = { delta: { content: final }, finish_reason: 'stop' }
            }
          } else if (body.includes('父会话专属后续提问')) {
            if (body.includes('合成子会话续聊完成')) {
              followupReplies++
              choice = { delta: { content: 'Web 父会话收到续聊结果' }, finish_reason: 'stop' }
            } else {
              const childId = (await pool.query('SELECT child_id FROM agent_subagent_conversations')).rows[0]?.child_id
              const started = body.includes('synthetic-followup-send')
              choice = { delta: { tool_calls: [{ index: 0, id: started ? 'synthetic-followup-wait' : 'synthetic-followup-send', type: 'function',
                function: { name: started ? 'agent_wait' : 'agent_message', arguments: JSON.stringify(started ? { childId }
                  : { action: 'send', childId, message: '继续核对前一份合成结果' }) } }] }, finish_reason: 'tool_calls' }
            }
          } else if (body.includes(final)) {
            choice = { delta: { content: '父 Run 汇总了子任务' }, finish_reason: 'stop' }
          } else {
            const started = body.includes('synthetic-delegate')
            if (workspaceMode && !started) assert.ok(body.includes(fileKey), '父 Run 未收到工作区引用键')
            const childId = started ? (await pool.query('SELECT child_id FROM agent_subagent_deliveries LIMIT 1')).rows[0]?.child_id : null
            choice = { delta: { tool_calls: [{ index: 0, id: started ? 'synthetic-wait' : 'synthetic-delegate', type: 'function',
              function: { name: started ? 'agent_wait' : 'agent_message', arguments: JSON.stringify(started ? { childId }
                : { action: 'spawn', agentId: 'builtin:searcher', task: '合成委派专用请求',
                ...(fileMode ? { resourceRefs: [fileKey] } : {}) }) } }] }, finish_reason: 'tool_calls' }
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
            `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 6, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: '合成任务' }, finish_reason: 'stop' }] }))
      } catch {
        response.writeHead(500).end()
      }
    })
    try {
      provider.listen(0, '127.0.0.1')
      await once(provider, 'listening')
      const endpoint = provider.address()
      assert.ok(endpoint && typeof endpoint !== 'string')
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await applyAgentBaseMigration(pool)
      await applyFilesystemAuthorizationMigration(pool)
      await applyWebDomainMigration(pool)
      await scheduledTaskMode.apply(pool)
      await providerCredentials.apply(pool)
      await byokBindings.apply(pool)
      await applyAgentRunMigration(pool)
      await applyInteractionActionsMigration(pool)
      assert.equal(await imGateway.apply(pool), 'applied')
      for (const migration of [subagentDeliveries, subagentSessions, subagentLaunches, subagentWaits, agentInbox, subagentConversations, subagentContinuations, subagentExecutions])
        assert.equal(await migration.apply(pool), 'applied')
      await pool.query('CREATE TABLE data_import_jobs (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL)')
      async function holdChildBeforeProvider() {
        gate = await pool.connect()
        await gate.query('SELECT pg_advisory_lock(918443)')
        await pool.query(`
          CREATE FUNCTION hold_searcher_model_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF OLD.phase='idle' AND NEW.phase='provider'
              AND EXISTS(SELECT 1 FROM agent_subagent_executions s WHERE s.child_run_id=NEW.run_id) THEN
              PERFORM pg_advisory_xact_lock(918443);
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER hold_searcher_model_boundary BEFORE UPDATE ON agent_run_checkpoints
            FOR EACH ROW EXECUTE FUNCTION hold_searcher_model_boundary()
        `)
      }
      if (restart) await holdChildBeforeProvider()
      const secret = 'synthetic-web-agent-secret'
      const config = join(root, 'config.test.json')
      await writeFile(config, JSON.stringify({ agent: {
        memory_enabled: false,
      } }))
      const probe = reservePort().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const listen = probe.address()
      assert.ok(listen && typeof listen !== 'string')
      await new Promise<void>(resolve => probe.close(() => resolve()))
      const env = {
        ...(shellMode ? { GUGU_BUBBLEWRAP_ROOTFS: shellRootfs, AGENT__AUTOMATIC_MODE_ENABLED: 'true' } : {}),
        GUGU_WEBUI_DATABASE_URL: url.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: redisUrl,
        CREDENTIALS_MASTER_KEY: 'synthetic-agent-confirmation-master-key',
        GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(listen.port), GUGU_CONFIG_OVERRIDE_FILE: config,
        STORAGE__LOCAL_PATH: join(root, 'storage'), AI__PROVIDER: 'local', AI__API_FORMAT: 'openai',
        AI__MODEL: 'synthetic-agent', AI__BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
        AI__API_KEY: 'synthetic-key', AI__CONTEXT_TOKENS: '65536', BYOK__ENABLED: 'false', MCP__ENABLED: 'false', SMTP__ENABLED: 'false',
        ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
        GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED: 'true',
      }
      const base = `http://127.0.0.1:${listen.port}`
      if (restart || mode === '跨父运行续聊') {
        const logFile = join(root, 'host.log')
        webProcess = spawn(process.execPath, [
          '--import', 'tsx', '--input-type=module', '--eval',
          'import { startServer } from "./src/main.ts"; await startServer()',
        ], {
          cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
          env: { ...env, GUGU_LOG_FILE: logFile },
          stdio: 'ignore',
        })
        await once(webProcess, 'spawn')
        const signal = AbortSignal.timeout(20_000)
        try {
          await waitFor(async () => {
            assert.equal(webProcess?.exitCode, null)
            try {
              const health = await fetch(base + '/health/ready', { signal })
              await health.body?.cancel()
              return health.ok
            } catch { return false }
          }, signal, () => '子进程未通过健康检查')
        } catch (error) {
          const log = await readFile(logFile, 'utf8').catch(() => '')
          const events = [...log.matchAll(/"event":"([a-z_.]+)"/gu)].map(match => match[1])
          throw new Error(`Web 子进程启动失败，事件：${events.join(', ') || '无启动日志'}`, { cause: error })
        }
      } else host = await startServer(env)
      const readiness = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(4000) })
      assert.equal(readiness.status, 200, await readiness.clone().text())
      assert.deepEqual(await readiness.json(), { status: 'ok' })
      const registration = await fetch(base + '/api/v1/auth/register', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': randomUUID() },
        body: JSON.stringify({ username: 'north-sample', email: 'north@example.test', password: 'Synthetic123!', locale: 'zh-CN' }),
        signal: AbortSignal.timeout(8000),
      })
      const responseText = await registration.text()
      assert.equal(registration.status, 201, responseText)
      const registered = JSON.parse(responseText) as { access_token: string; user: { id: string } }
      assert.ok(registered.access_token)
      const auth = { authorization: `Bearer ${registered.access_token}` }
      let shellResultPath: string | undefined
      if (shellMode) {
        const { rows: [directory] } = await pool.query<{ directory_name: string }>(
          'SELECT directory_name FROM workspace_directories WHERE user_id=$1 AND is_default', [registered.user.id])
        assert.ok(directory)
        const workspace = join(root, 'storage', registered.user.id, 'workspace', directory.directory_name)
        await mkdir(workspace, { recursive: true })
        shellResultPath = join(workspace, 'synthetic-searcher.txt')
        await pool.query(`INSERT INTO user_preferences(user_id,data_json) VALUES($1,$2)
          ON CONFLICT (user_id) DO UPDATE SET data_json=EXCLUDED.data_json`,
        [registered.user.id, JSON.stringify({ automatic_mode_enabled: !confirmShell })])
      }
      if (workspaceMode) {
        const { rows: [directory] } = await pool.query<{ id: number; directory_name: string }>(
          'SELECT id,directory_name FROM workspace_directories WHERE user_id=$1 AND is_default', [registered.user.id])
        assert.ok(directory)
        const storageRoot = join(root, 'storage')
        const storage = join(storageRoot, registered.user.id, 'workspace', directory.directory_name)
        await mkdir(storage, { recursive: true })
        const workspace = createWorkspaceFileReads(pool, storageRoot)
        const createFile = async (name: string, content: string) => {
          await writeFile(join(storage, name), content)
          return workspace.reference(registered.user.id, directory.id, name)
        }
        fileId = (await createFile('合成授权文件.txt', '合成授权文件正文')).id
        excludedFileId = (await createFile('合成排除文件.txt', '合成排除文件正文')).id
        fileKey = parseWorkspaceFileReference(fileId)!.key
        excludedFileKey = parseWorkspaceFileReference(excludedFileId)!.key
      } else if (fileMode) {
        const storage = join(root, 'storage', registered.user.id, '个人文件')
        await mkdir(storage, { recursive: true })
        const createFile = async (name: string, content: string) => {
          await writeFile(join(storage, name + '.txt'), content)
          const { rows: [record] } = await pool.query<{ id: number }>(`
            INSERT INTO files(user_id,display_name,ext,storage_key,size_bytes)
            VALUES($1,$2,'txt',$3,$4) RETURNING id`,
          [registered.user.id, name, `${registered.user.id}/个人文件/${name}.txt`, Buffer.byteLength(content)])
          return record!.id
        }
        fileId = await createFile('合成授权文件', '合成授权文件正文')
        excludedFileId = await createFile('合成排除文件', '合成排除文件正文')
        fileKey = String(fileId)
      }
      const chat = (message: string, sessionId?: number, attachments?: string[]) => fetch(base + '/api/v1/agent/chat', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ message, locale: 'zh-CN', session_id: sessionId, attachments,
          references: fileMode ? [fileId, excludedFileId].map(id => ({ type: 'file', id })) : undefined }), signal: AbortSignal.timeout(12_000),
      })
      const delegated = await chat('合成委派专用请求')
      assert.equal(delegated.status, 200)
      if (confirmShell) {
        await waitFor(async () => Boolean((await pool.query(`
          SELECT 1 FROM agent_subagent_executions s JOIN agent_run_checkpoints c ON c.run_id=s.child_run_id
          WHERE c.status='waiting'`)).rowCount), AbortSignal.timeout(8000), () => '子 Shell 未等待确认')
        await assert.rejects(readFile(shellResultPath!), { code: 'ENOENT' })
        const parent = (await pool.query('SELECT parent_session_id,parent_run_id FROM agent_subagent_deliveries')).rows[0]
        const history = await fetch(`${base}/api/v1/agent/sessions/${parent.parent_session_id}/messages?restore_interactions=true`,
          { headers: auth, signal: AbortSignal.timeout(5000) })
        assert.equal(history.status, 200)
        const data = await history.json() as { interactions: Array<{ id: number; delegated?: boolean; options: Array<{ id: string; token: string }> }> }
        const prompt = data.interactions.find(item => item.delegated)
        const token = prompt?.options.find(item => item.id === 'confirm')?.token
        assert.ok(prompt && token)
        const approved = await fetch(`${base}/api/v1/agent/interactions/${prompt.id}/resume`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000),
        })
        assert.equal(approved.status, 200, await approved.clone().text())
        assert.equal((await approved.json() as { run_id: string }).run_id, parent.parent_run_id)
      }
      if (cancellation) {
        await waitFor(async () => childStreamStarted && !!(await pool.query('SELECT 1 FROM agent_subagent_waits')).rowCount,
          AbortSignal.timeout(5000), () => '派单未进入持久等待')
        const parent = (await pool.query('SELECT parent_session_id FROM agent_subagent_deliveries')).rows[0]
        assert.ok(parent)
        const cancelled = await fetch(`${base}/api/v1/agent/sessions/${parent.parent_session_id}/cancel`, {
          method: 'POST', headers: auth, signal: AbortSignal.timeout(5000),
        })
        assert.equal(cancelled.status, 200)
        await waitFor(async () => childStreamClosed && !!(await pool.query(`
          SELECT 1 FROM agent_subagent_deliveries d JOIN agent_run_checkpoints p
          ON p.run_id=d.parent_run_id AND p.user_id::text=d.owner_id AND p.session_id::text=d.parent_session_id
          WHERE p.status='cancelled' AND d.status='cancelled' AND d.consumed_checkpoint_version IS NULL`)).rowCount,
        AbortSignal.timeout(8000), () => '父或子取消未持久化')
        assert.equal(parentRequests, 2)
        await delegated.text()
        return
      }
      let originalChildId: string | undefined
      if (restart) {
        const parentStream = delegated.text().catch(() => '')
        await waitFor(async () => !!(await pool.query(`
          SELECT 1 FROM agent_subagent_waits w JOIN agent_subagent_deliveries d
            ON w.owner_id=d.owner_id AND w.parent_session_id=d.parent_session_id AND w.parent_run_id=d.parent_run_id AND w.child_id=d.child_id
          JOIN agent_run_checkpoints c ON c.run_id=d.child_run_id WHERE c.status='running' AND c.phase='idle'`)).rowCount,
          AbortSignal.timeout(5000), () => '重启前未达到安全的子 Run checkpoint')
        originalChildId = (await pool.query('SELECT child_run_id FROM agent_subagent_deliveries')).rows[0]?.child_run_id
        assert.ok(originalChildId)
        await stopProcess()
        await parentStream
        assert.equal(childRequests, 0)
        await gate?.query('SELECT pg_advisory_unlock(918443)')
        gate?.release()
        gate = undefined
        // 模拟退出后的租约到期，保持原 checkpoint 与派单不变。
        await pool.query("UPDATE agent_run_leases SET expires_at=clock_timestamp()-interval '1 second'")
        await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second'")
        // 模拟缺少普通准入记录的旧派单，保留原执行与 checkpoint。
        await pool.query('DELETE FROM agent_run_dispatch WHERE run_id=$1', [originalChildId])
        await pool.query('DELETE FROM agent_run_startups WHERE run_id=$1', [originalChildId])
        await pool.query("DELETE FROM conversation_messages WHERE run_id=$1 AND role='user'", [originalChildId])
        host = await startServer(env)
      } else assert.match(await delegated.text(), /父 Run 汇总了子任务/u, '原聊天流应收到续跑后的父回复')
      await waitFor(async () => Boolean((await pool.query(`
        SELECT 1 FROM agent_subagent_deliveries d JOIN agent_run_checkpoints p
        ON p.run_id=d.parent_run_id AND p.user_id::text=d.owner_id AND p.session_id::text=d.parent_session_id
        WHERE p.status='completed' AND d.status='completed' AND d.consumed_checkpoint_version IS NOT NULL`)).rowCount),
      AbortSignal.timeout(12_000), () => 'Web 父 Run 没有续跑并消费 Searcher 终态')
      if (mode === '跨父运行续聊') {
        const { rows: [parent] } = await pool.query('SELECT parent_session_id,parent_run_id,child_id FROM agent_subagent_deliveries')
        await holdChildBeforeProvider()
        const reply = await chat('父会话专属后续提问', Number(parent.parent_session_id))
        assert.equal(reply.status, 200)
        const parentStream = reply.text().catch(() => '')
        await waitFor(async () => !!(await pool.query(`
          SELECT 1 FROM agent_subagent_waits w JOIN agent_subagent_deliveries d
            ON w.owner_id=d.owner_id AND w.parent_session_id=d.parent_session_id AND w.parent_run_id=d.parent_run_id AND w.child_id=d.child_id
          JOIN agent_run_checkpoints c ON c.run_id=d.child_run_id
          WHERE d.parent_run_id<>$1 AND c.status='running' AND c.phase='idle'`, [parent.parent_run_id])).rowCount,
        AbortSignal.timeout(8000), () => '续聊重启前未达到子 Run checkpoint')
        const { rows: [followup] } = await pool.query(
          'SELECT parent_run_id,child_run_id,child_id FROM agent_subagent_deliveries WHERE parent_run_id<>$1', [parent.parent_run_id])
        assert.equal(followup.child_id, parent.child_id)
        const startup = await pool.query(`
          SELECT a.run_id FROM agent_run_startups a
          JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
          JOIN conversation_messages m ON m.session_id=s.id AND m.run_id=a.run_id
          WHERE a.run_id=$1 AND s.source='subagent' AND m.role='user'`, [followup.child_run_id])
        assert.deepEqual(startup.rows, [{ run_id: followup.child_run_id }])
        const held = await pool.query('SELECT state,fence,token IS NOT NULL AS leased FROM agent_run_dispatch WHERE run_id=$1', [followup.child_run_id])
        assert.deepEqual(held.rows.map(row => ({ ...row, fence: Number(row.fence) })), [
          { state: 'selected', fence: 1, leased: true },
        ])
        assert.equal(childRequests, 1)
        assert.equal(followupRequests, 0)
        await stopProcess()
        await parentStream
        await gate?.query('SELECT pg_advisory_unlock(918443)')
        gate?.release()
        gate = undefined
        await pool.query("UPDATE agent_run_leases SET expires_at=clock_timestamp()-interval '1 second'")
        await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second'")
        host = await startServer(env)
        await waitFor(async () => !!(await pool.query(`
          SELECT 1 FROM agent_subagent_deliveries d JOIN agent_run_checkpoints p ON p.run_id=d.parent_run_id
          WHERE d.child_run_id=$1 AND p.status='completed' AND d.status='completed'
            AND d.consumed_checkpoint_version IS NOT NULL`, [followup.child_run_id])).rowCount,
        AbortSignal.timeout(12_000), () => '重启后父 Run 未消费续聊 final')
        const deliveries = await pool.query('SELECT child_id,child_run_id FROM agent_subagent_deliveries')
        assert.equal(deliveries.rowCount, 2)
        assert.deepEqual(deliveries.rows.filter(row => row.child_run_id === followup.child_run_id), [
          { child_id: parent.child_id, child_run_id: followup.child_run_id },
        ])
        assert.equal(childRequests, 1)
        assert.equal(followupRequests, 1)
        assert.equal(followupReplies, 1)
        await waitFor(async () => Boolean((await pool.query(
          "SELECT 1 FROM agent_run_dispatch WHERE run_id=$1 AND state='done' AND fence>1", [followup.child_run_id])).rowCount),
        AbortSignal.timeout(5000), () => '恢复后的普通派单未完成')
        const { rows } = await pool.query('SELECT child_session_id FROM agent_subagent_executions')
        assert.equal(rows.length, 2)
        assert.equal(new Set(rows.map(row => row.child_session_id)).size, 1)
      }
      if (fileMode) assert.equal(childRequests, 4)
      if (shellResultPath) assert.equal(await readFile(shellResultPath, 'utf8'), '合成共享结果')
      if (restart) {
        const children = await pool.query('SELECT child_run_id FROM agent_subagent_deliveries')
        assert.deepEqual(children.rows, [{ child_run_id: originalChildId }])
        const admission = await pool.query('SELECT run_id FROM agent_run_startups WHERE run_id=$1', [originalChildId])
        assert.deepEqual(admission.rows, [{ run_id: originalChildId }])
        assert.equal(childRequests, 1)
        assert.equal(parentRequests, 3)
      }
    } finally {
      await stopProcess()
      gate?.release(true)
      await host?.close()
      provider.closeAllConnections()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      await pool.end()
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
      finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
    }
  })
}
