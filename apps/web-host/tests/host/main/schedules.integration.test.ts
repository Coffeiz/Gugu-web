import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import dns from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates } from 'node:tls'
import type { LightMyRequestResponse } from 'fastify'
import { Pool } from 'pg'
import { tablesSql } from '@gugu/core/data'
import { encryptEncryptedString } from '../../../src/adapters/security/encrypted-string.js'
import { createRedisExpiringValueStore } from '../../../src/adapters/cache/redis-events.js'
import { startServer } from '../../../src/main.js'
import { signedUserToken } from '../../helpers/auth.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

function scheduledPrompt(request: string): string {
  const { messages } = JSON.parse(request) as { messages: Array<{ role: string; content?: unknown }> }
  for (const { role, content } of messages) {
    if (role !== 'user') continue
    const messageText = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
    if (messageText.includes('[定时任务触发：')) return messageText
  }
  return ''
}

test('生产 Host 立即运行经真实模型协议和任务工具续轮投递，试运行保留原任务', {
  skip: !(pgUrl && redisUrl) && '需要隔离 PostgreSQL 和 Redis',
}, async () => {
  const schema = `scheduled_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const scoped = new URL(pgUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString() })
  const root = await mkdtemp(join(tmpdir(), 'gugu-scheduled-main-'))
  const requests: string[] = []
  const deliveries: string[] = []
  const receivedRecipients: string[] = []
  const wechatMessages: unknown[] = []
  const wechatTickets: Array<Record<string, unknown>> = []
  const wechatUploads: Buffer[] = []
  const wechatUploadPaths: string[] = []
  let wechatRefreshReach: string | undefined
  let invalidWechatUpload = false
  let rejectedWechatFile = false
  let wechatCdnResponse = 503
  const feishuUploads: Array<{ path: string; body: string }> = []
  const feishuMessages: Record<string, unknown>[] = []
  let rejectFeishuImage = true
  let unsafeQqUpload = false
  let qqFileMessageHasAck = true
  let revokeQqAfterUpload = false
  const qqCalls: Array<{ path: string; body: Record<string, unknown> }> = []
  const qqParts = new Map<string, string>()
  const fetchedImagePaths: string[] = []
  const proxyTargets: string[] = []
  const remoteImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4zsAAAAASUVORK5CYII=', 'base64')
  const defaultCAs = getCACertificates('default')
  const redis = createRedisExpiringValueStore(redisUrl!)
  const reachKeys: string[] = []
  const tunnels = new Set<Duplex>()
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(Buffer.concat(chunks).toString())
    const input = requests.at(-1) ?? ''
    const hasUnresolvedCheck = input.includes('合成周期校验失败')
    const requestGroupSearch = input.includes('合成群历史搜索') && !input.includes('synthetic-group-search')
    const requestMail = input.includes('合成邮件工具') && !input.includes('synthetic-email-call')
    // 会话资料也可能包含同账号的其他定时任务，只按本轮任务选择附件场景。
    const prompt = scheduledPrompt(input)
    const requestArtifact = prompt.includes('合成定时附件') && !input.includes('synthetic-file-call')
    if (requestGroupSearch && input.includes('合成群历史搜索撤权')) await pool.query('UPDATE user_bots SET enabled=false WHERE id=5')
    if (requestMail && input.includes('合成邮件工具撤权')) await pool.query("UPDATE scheduled_tasks SET authorized_tools='[]' WHERE id=30")
    const artifactArgs = prompt.includes('合成定时附件 URL')
      ? [JSON.stringify({ url: 'https://files.example.invalid/' + (prompt.includes('合成定时附件 URL 私网') ? 'private-redirect'
        : prompt.includes('合成定时附件 URL 停用') ? 'disable-after-fetch' : 'redirect'),
        title: prompt.includes('合成定时附件 URL 到期') ? 'synthetic-remote-worker' : 'synthetic-remote' })]
      : prompt.includes('合成定时附件飞书') || prompt.includes('合成定时附件微信')
      ? ['{"file":"synthetic-schedule.txt","title":"synthetic-report.txt"}', '{"attach_id":"synthetic-staged-image"}']
      : [prompt.includes('合成定时附件异主') ? '{"file_id":8}' : '{"file_id":7}']
    const choice = requestArtifact
      ? { delta: { tool_calls: artifactArgs.map((args, index) => ({ index, id: `synthetic-file-call-${index}`, type: 'function',
        function: { name: 'send_file', arguments: args } })) }, finish_reason: 'tool_calls' }
      : requestMail
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-email-call', type: 'function',
        function: { name: 'send_email', arguments: '{"subject":"Synthetic schedule","body":"Synthetic body","format":"plain"}' } }] }, finish_reason: 'tool_calls' }
      : requestGroupSearch
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-group-search', type: 'function',
        function: { name: 'group_context_search', arguments: '{"query":"合成部署","speaker":"小北"}' } }] }, finish_reason: 'tool_calls' }
      : (input.includes('合成周期执行') || hasUnresolvedCheck) && !input.includes('synthetic-stop')
      ? { delta: { tool_calls: [
        { index: 0, id: 'synthetic-stop', type: 'function', function: { name: 'stop_recurring', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }
      : hasUnresolvedCheck && !input.includes('synthetic-check')
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-check', type: 'function',
          function: { name: 'use_skill', arguments: '{"id":"U987654"}' } }] }, finish_reason: 'tool_calls' }
      : input.includes('确认当前时间') && !input.includes('synthetic-clock')
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-clock', type: 'function',
        function: { name: 'get_current_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { delta: { content: '定时工作已完成' }, finish_reason: 'stop' }
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`)
  })
  let smtp: ReturnType<typeof createTlsServer> | undefined
  let relay: ReturnType<typeof createHttpsServer> | undefined
  let proxy: ReturnType<typeof createServer> | undefined
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  const originalLookup = dns.lookup
  const relayHosts = new Set([
    'ilinkai.weixin.qq.com', 'novac2c.cdn.weixin.qq.com', 'open.feishu.cn',
    'api.bot.qq.com', 'cos.ap-guangzhou.myqcloud.com', 'cloudflare-dns.com',
  ])
  const relayIp = '93.184.215.14'
  try {
    // 合成平台域名交给本地代理，避免系统 DNS 或假 IP 影响地址校验。
    dns.lookup = ((host: string, options?: Parameters<typeof originalLookup>[1]) => {
      if (!relayHosts.has(host)) return originalLookup(host, options)
      const address = { address: relayIp, family: 4 }
      return Promise.resolve(typeof options === 'object' && options.all ? [address] : address)
    }) as typeof originalLookup
    syncBuiltinESMExports()
    const certificate = join(root, 'cert.pem'), key = join(root, 'key.pem'), opensslConfig = join(root, 'openssl.cnf')
    await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n'
      + '[dn]\nCN=localhost\n[extensions]\nsubjectAltName=IP:127.0.0.1,DNS:ilinkai.weixin.qq.com,DNS:novac2c.cdn.weixin.qq.com,DNS:open.feishu.cn,DNS:api.bot.qq.com,DNS:cos.ap-guangzhou.myqcloud.com,DNS:cloudflare-dns.com,DNS:files.example.invalid\n')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', opensslConfig, '-keyout', key, '-out', certificate], { stdio: 'ignore' })
    const tls = { key: await readFile(key), cert: await readFile(certificate) }
    setDefaultCACertificates([...defaultCAs, tls.cert.toString()])
    smtp = createTlsServer(tls, socket => {
      socket.setEncoding('utf8')
      socket.write('220 localhost ESMTP\r\n')
      let pending = '', content: string[] | null = null
      socket.on('data', chunk => {
        pending += chunk
        let index: number
        while ((index = pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0, index)
          pending = pending.slice(index + 2)
          if (content !== null) {
            if (line === '.') {
              deliveries.push(content.join('\n'))
              content = null
              socket.write('250 accepted\r\n')
            } else content.push(line)
          } else if (line.startsWith('EHLO ') || line.startsWith('MAIL FROM:')) socket.write('250 localhost\r\n')
          else if (line.startsWith('RCPT TO:')) { receivedRecipients.push(line); socket.write('250 accepted\r\n') }
          else if (line === 'DATA') { content = []; socket.write('354 continue\r\n') }
          else if (line === 'QUIT') socket.end('221 bye\r\n')
          else socket.write('500 unsupported\r\n')
        }
      })
    })
    await new Promise<void>(resolve => smtp!.listen(0, '127.0.0.1', resolve))
    const smtpAddress = smtp.address()
    assert.ok(smtpAddress && typeof smtpAddress !== 'string')
    relay = createHttpsServer(tls, async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      if (request.headers.host === 'cloudflare-dns.com') {
        const dns = new URL(request.url!, 'https://cloudflare-dns.com')
        assert.equal(dns.searchParams.get('name'), 'files.example.invalid')
        const answer = dns.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.215.14' }] : []
        return response.writeHead(200, { 'content-type': 'application/dns-json' }).end(JSON.stringify({ Status: 0, Answer: answer }))
      }
      if (request.headers.host === 'files.example.invalid') {
        assert.equal(request.headers.authorization, undefined)
        fetchedImagePaths.push(request.url ?? '')
        if (request.url === '/redirect') return response.writeHead(302, { location: '/image.png' }).end()
        if (request.url === '/private-redirect') return response.writeHead(302, { location: 'https://127.0.0.1/private-image' }).end()
        if (request.url === '/disable-after-fetch') await pool.query('UPDATE scheduled_tasks SET enabled=false WHERE id=42')
        else assert.equal(request.url, '/image.png')
        return response.writeHead(200, { 'content-type': 'image/png' }).end(remoteImage)
      }
      if (request.headers.host === 'novac2c.cdn.weixin.qq.com') {
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.authorization, undefined)
        assert.equal(request.headers['content-type'], 'application/octet-stream')
        wechatUploads.push(Buffer.concat(chunks))
        wechatUploadPaths.push(request.url ?? '')
        const status = wechatCdnResponse
        wechatCdnResponse = 200
        if (status === 200 && wechatRefreshReach) {
          const key = wechatRefreshReach
          wechatRefreshReach = undefined
          await redis.delete(key)
          assert.equal(await redis.saveIfAbsent(key, JSON.stringify({
            platform: 'wechat', channel_id: 6, chat_type: 'c2c', puid: 'synthetic-private', context_token: 'synthetic-fresh-context',
          }), 60), true)
        }
        return response.writeHead(status, { 'x-encrypted-param': 'synthetic-cdn-receipt' }).end()
      }
      if (request.headers.host === 'cos.ap-guangzhou.myqcloud.com') {
        assert.equal(request.method, 'PUT')
        assert.equal(request.headers.authorization, undefined)
        qqParts.set(request.url ?? '', body)
        return response.writeHead(200).end()
      }
      if (request.headers.host === 'api.bot.qq.com') {
        const path = request.url ?? ''
        response.setHeader('content-type', 'application/json')
        if (path === '/app/getAppAccessToken') return response.end('{"access_token":"synthetic-qq-token"}')
        assert.equal(request.headers.authorization, 'QQBot synthetic-qq-token')
        qqCalls.push({ path, body: JSON.parse(body) })
        if (path.endsWith('/upload_prepare')) return response.end(JSON.stringify({
          upload_id: 'synthetic-upload', block_size: '16', upload_config: { concurrency: 2 },
          parts: [2, 1].map(index => ({ index, presigned_url: unsafeQqUpload && index === 2
            ? 'https://example.invalid/unsafe-part' : `https://cos.ap-guangzhou.myqcloud.com/synthetic-part-${index}` })),
        }))
        if (path.endsWith('/upload_part_finish')) return response.end('{}')
        if (path.endsWith('/files')) {
          if (revokeQqAfterUpload) await pool.query('UPDATE user_bots SET enabled=false WHERE id=8')
          return response.end('{"file_info":"synthetic-qq-file"}')
        }
        assert.ok(path.endsWith('/messages'))
        if (qqCalls.at(-1)?.body.msg_type === 7 && !qqFileMessageHasAck) return response.end('{}')
        return response.end('{"id":"synthetic-qq-message"}')
      }
      if (request.headers.host === 'open.feishu.cn') {
        response.setHeader('content-type', 'application/json')
        if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') return response.end('{"code":0,"tenant_access_token":"synthetic-feishu-token"}')
        assert.equal(request.headers.authorization, 'Bearer synthetic-feishu-token')
        if (request.url?.startsWith('/open-apis/im/v1/messages?')) {
          feishuMessages.push(JSON.parse(body))
          return response.end('{"code":0,"data":{"message_id":"om_synthetic"}}')
        }
        assert.match(request.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/u)
        feishuUploads.push({ path: request.url ?? '', body })
        return response.end(request.url === '/open-apis/im/v1/files' ? '{"code":0,"data":{"file_key":"synthetic-feishu-file"}}'
          : rejectFeishuImage ? '{"code":999,"msg":"synthetic rejected"}' : '{"code":0,"data":{"image_key":"synthetic-feishu-image"}}')
      }
      assert.equal(request.headers.authorization, 'Bearer synthetic-wechat-token')
      if (request.url === '/ilink/bot/getuploadurl') {
        const ticket = JSON.parse(body)
        wechatTickets.push(ticket)
        const url = invalidWechatUpload ? 'https://example.invalid/c2c/upload' : 'https://novac2c.cdn.weixin.qq.com/c2c/upload?fixture=synthetic'
        return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ticket.media_type === 1 && !invalidWechatUpload
          ? { upload_param: 'synthetic-ticket' } : { upload_full_url: url }))
      }
      assert.equal(request.url, '/ilink/bot/sendmessage')
      const msg = JSON.parse(body).msg
      wechatMessages.push(msg)
      response.writeHead(200, { 'content-type': 'application/json' }).end(rejectedWechatFile && msg.item_list[0].type === 4 ? '{"ret":-1}' : '{"ret":0}')
    })
    await new Promise<void>(resolve => relay!.listen(0, '127.0.0.1', resolve))
    const relayAddress = relay.address()
    assert.ok(relayAddress && typeof relayAddress !== 'string')
    // CONNECT 只连接此合成 iLink 对端，所有请求均留在测试进程。
    proxy = createServer((_request, response) => response.writeHead(405).end())
    proxy.on('connect', (request, client, head) => {
      if (request.url !== `${relayIp}:443` && request.url !== 'cloudflare-dns.com:443') { client.destroy(); return }
      proxyTargets.push(request.url)
      const upstream = connect(relayAddress.port, '127.0.0.1')
      tunnels.add(client)
      tunnels.add(upstream)
      client.on('close', () => { tunnels.delete(client); upstream.destroy() })
      upstream.on('close', () => { tunnels.delete(upstream); client.destroy() })
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
    })
    await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve))
    const proxyAddress = proxy.address()
    assert.ok(proxyAddress && typeof proxyAddress !== 'string')
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const endpoint = provider.address()
    assert.ok(endpoint && typeof endpoint !== 'string')
    const socket = createSocket()
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
    const http = socket.address()
    assert.ok(http && typeof http !== 'string')
    await new Promise<void>(resolve => socket.close(() => resolve()))
    const config = join(root, 'synthetic-config.json')
    await writeFile(config, '{}')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text,display_name text,email text,is_active boolean,account_status text,
      security_version int,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,last_active_at timestamptz,
      token_limit_6h integer,quota_window_started_at timestamptz);
      CREATE TABLE user_preferences(user_id uuid,data_json text,data jsonb);
      CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid,status text);
      CREATE TABLE user_provider_bindings(user_id uuid,capability text,credential_id int,PRIMARY KEY(user_id,capability));
      CREATE TABLE user_smtp_configs(user_id uuid,enabled boolean,host text,port int,"user" text,password text,from_addr text,use_ssl boolean);
      CREATE TABLE user_bots(user_id uuid,platform text,enabled boolean);
      CREATE TABLE user_skills(owner_id uuid,skill_id text,name text,description_short text,category text,related_tools jsonb,
        managed_by text,enabled boolean,source text,body text,content_digest text);
      CREATE TABLE scheduled_tasks(id int PRIMARY KEY,user_id uuid,enabled boolean,name text,payload text,channels text,
        delivery_targets jsonb,authorized_tools jsonb,email_attachment_file_ids jsonb,workspace_id int,
        filesystem_authorization_grant_id int,schedule_kind text,end_at timestamptz,start_at timestamptz,
        last_run_at timestamptz,last_run_failed boolean,cron text DEFAULT '* * * * *',interval_minutes integer,
        event_id integer,reminder_lead_minutes integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE projects(id int PRIMARY KEY,user_id uuid,name text,status text,priority text,start_date date,deadline date,
        done_at timestamptz,contact_name text,summary text,stages_json text,deleted_at timestamptz,archived boolean);
      CREATE TABLE calendar_events(user_id uuid,date text,title text,deleted_at timestamptz);
      CREATE TABLE folders(id int PRIMARY KEY,user_id uuid,name text,project_id int,workspace_directory_id int,parent_id int,deleted_at timestamptz);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,display_name text,ext text,space text,folder_id int,project_id int,
        deleted_at timestamptz,updated_at timestamptz,storage_key text,storage_backend text,size_bytes int,mime_type text);
      CREATE TABLE agent_usage(id serial PRIMARY KEY,user_id uuid,session_id integer,tokens_in integer,tokens_out integer,
        cache_read integer,cache_write integer,cache_round_stats jsonb,model text,provider text,is_byok boolean,
        tools_used jsonb,scenario text,input_source text,created_at timestamptz);
      CREATE TABLE site_notifications(id serial PRIMARY KEY,title text,content text,color text,target text,bubble boolean,persist boolean,
        bubble_expire_at timestamptz,created_by text,created_at timestamptz)`)
    await pool.query(tablesSql('postgres').ragJobs)
    await pool.query(tablesSql('postgres').scheduledFires)
    await pool.query(tablesSql('postgres').receipts)
    const owner = randomUUID(), other = randomUUID(), secret = 'synthetic-scheduled-main-secret'
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at,timezone,email_subscribed)
      VALUES($1,'synthetic-owner','owner@example.test',TRUE,'active',1,NOW(),'Asia/Shanghai',FALSE),
      ($2,'synthetic-foreign','foreign@example.test',TRUE,'active',1,NOW(),'UTC',FALSE)`, [owner, other])
    await pool.query(`INSERT INTO scheduled_tasks VALUES(18,$1,TRUE,'例行检查','确认当前时间','web','{}','[]','[]',NULL,NULL,'once',
      NULL,NOW()-interval '1 minute',NULL,FALSE),
      (20,$1,TRUE,'后台到期任务','合成自动执行 合成邮件工具后台','web','{}','["send_email"]','[]',NULL,NULL,'once',
      NULL,NOW()+interval '1 day',NULL,FALSE),
      (21,$1,FALSE,'已过期任务','不执行','web','{}','[]','[]',NULL,NULL,'once',
      NULL,NOW()-interval '3 minutes',NULL,FALSE),
      (22,$1,TRUE,'崩溃任务','不自动重试','web','{}','[]','[]',NULL,NULL,'once',
      NULL,NOW()-interval '11 minutes',NOW()-interval '11 minutes',FALSE)`, [owner])
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,interval_minutes,start_at,end_at,event_id) VALUES
      (23,$1,TRUE,'周期到期任务','合成周期执行','web','{}','[]','[]','interval',1,NOW()+interval '1 day',NULL,NULL),
      (24,$1,FALSE,'已结束独立任务','不执行','web','{}','[]','[]','interval',1,NOW()-interval '1 hour',NOW()-interval '5 minutes',NULL),
      (25,$1,FALSE,'已结束日历提醒','不执行','web','{}','[]','[]','interval',1,NOW()-interval '1 hour',NOW()-interval '5 minutes',1),
      (26,$1,TRUE,'周期校验失败任务','合成周期校验失败','web','{}','[]','[]','interval',1,NOW()+interval '1 day',NULL,NULL)`, [owner])
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: redisUrl,
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(http.port), GUGU_CONFIG_OVERRIDE_FILE: config,
      STORAGE__LOCAL_PATH: join(root, 'storage'), GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED: 'true', GUGU_WEBUI_REPEATING_TASK_WORKER_ENABLED: 'true',
      AI__PROVIDER: 'local', AI__API_FORMAT: 'openai',
      AI__MODEL: 'synthetic-scheduled-model', AI__BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
      AI__API_KEY: 'synthetic-local-key', AI__CONTEXT_TOKENS: '32768', BYOK__ENABLED: 'false', MCP__ENABLED: 'false', IM__QQ: 'false',
      SMTP__HOST: '127.0.0.1', SMTP__PORT: String(smtpAddress.port), SMTP__FROM_ADDR: 'sender@example.test',
      SMTP__USE_SSL: 'true', SSL_CERT_FILE: certificate,
      HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`, NO_PROXY: '127.0.0.1', https_proxy: `http://127.0.0.1:${proxyAddress.port}`, no_proxy: '127.0.0.1', IM__WECHAT: 'true',
    })
    const manualRequests = () => requests.filter(body => !body.includes('合成自动执行') && !body.includes('合成周期'))
    const run = (id: number, user?: string) => fetch(`http://127.0.0.1:${http.port}/api/v1/scheduled-tasks/${id}/run`, {
      method: 'POST',
      headers: user ? { authorization: `Bearer ${signedUserToken(secret, user)}` } : {},
    })
    const unauthenticated = await run(18)
    assert.equal(unauthenticated.status, 401)
    await unauthenticated.body?.cancel()
    const foreign = await run(18, other)
    assert.equal(foreign.status, 404)
    await foreign.body?.cancel()
    assert.equal(manualRequests().length, 0)
    const result = await run(18, owner)
    assert.equal(result.status, 200)
    assert.deepEqual((await result.json()).result, { 'web 通知': '已发送' })
    assert.equal(manualRequests().length, 2)
    assert.match(manualRequests()[0]!, /确认当前时间/u)
    assert.match(manualRequests()[1]!, /Asia\/Shanghai/u)
    assert.deepEqual((await pool.query("SELECT content,target FROM site_notifications WHERE title='例行检查'")).rows,
      [{ content: '定时工作已完成', target: owner }])
    assert.deepEqual((await pool.query('SELECT last_run_at,last_run_failed FROM scheduled_tasks WHERE id=18')).rows,
      [{ last_run_at: null, last_run_failed: false }])
    assert.deepEqual((await pool.query('SELECT user_id,session_id,tokens_in,tokens_out,scenario,tools_used FROM agent_usage WHERE tools_used IS NOT NULL')).rows,
      [{ user_id: owner, session_id: null, tokens_in: 8, tokens_out: 4, scenario: 'scheduled', tools_used: ['get_current_time'] }])
    await pool.query("UPDATE scheduled_tasks SET authorized_tools='[\"send_email\"]' WHERE id=18")
    const authorized = await run(18, owner)
    assert.deepEqual((await authorized.json()).result, { 'web 通知': '已发送' })
    assert.equal(manualRequests().length, 4)
    assert.doesNotMatch(manualRequests()[0]!, /"name":"send_email"/u)
    assert.match(manualRequests()[2]!, /"name":"send_email"/u)

    await pool.query(`INSERT INTO scheduled_tasks VALUES(19,$1,TRUE,'待重试任务','再次确认时间','web','{}','[]','[]',
      NULL,NULL,'once',NULL,NOW()+interval '1 day',NOW()-interval '1 minute',TRUE)`, [owner])
    const retried = await run(19, owner)
    assert.equal(retried.status, 200)
    assert.deepEqual((await retried.json()).result, { 'web 通知': '已发送' })
    assert.equal(manualRequests().length, 5)
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=19')).rowCount, 0)
    // 通过正式更新入口在 Host 启动后安排触发，避免慢启动消耗本次触发窗口。
    const auth = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    for (const [id, authorized_tools] of [[20, ['send_email']], [23, []], [26, []]] as const) {
      const updated: LightMyRequestResponse = await host.app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${id}`, headers: auth,
        payload: { start_at: new Date(Date.now() + 7000).toISOString(), authorized_tools } })
      assert.equal(updated.statusCode, 200, updated.body)
    }
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const pending = await pool.query(`SELECT id FROM scheduled_tasks WHERE id=20
        UNION ALL SELECT expected.id FROM (VALUES (23),(26)) AS expected(id)
        WHERE NOT EXISTS (SELECT 1 FROM scheduled_task_fires WHERE task_id=expected.id AND status='completed')`)
      if (!pending.rowCount) break
      await delay(100)
    }
    assert.deepEqual((await pool.query('SELECT id,last_run_failed FROM scheduled_tasks WHERE id IN (20,21,22) ORDER BY id')).rows,
      [{ id: 22, last_run_failed: true }])
    const automatic = requests.filter(body => body.includes('合成自动执行'))
    assert.equal(automatic.length, 2)
    assert.match(automatic[1]!, /smtp_accepted/u)
    assert.deepEqual((await pool.query("SELECT title,target FROM site_notifications WHERE title='后台到期任务'")).rows,
      [{ title: '后台到期任务', target: owner }])
    const indexed = await pool.query("SELECT user_id,pending_source_ids FROM rag_index_jobs WHERE source_type='scheduled_task'")
    assert.deepEqual(indexed.rows.map(row => ({ owner: row.user_id, ids: [...row.pending_source_ids].sort() })),
      [{ owner, ids: ['19', '20', '21', '23', '24', '26'] }])
    const recurring = requests.filter(body => body.includes('合成周期执行'))
    assert.equal(recurring.length, 2)
    assert.ok(recurring[0]?.includes('stop_recurring'), '周期 Worker 应提供停用意图工具')
    assert.ok(recurring[1]?.includes('已登记停止当前周期任务'), '模型续轮应收到已登记回执')
    assert.deepEqual((await pool.query("SELECT task_id,status FROM scheduled_task_fires ORDER BY task_id")).rows,
      [{ task_id: 23, status: 'completed' }, { task_id: 26, status: 'completed' }])
    assert.deepEqual((await pool.query("SELECT id FROM scheduled_tasks WHERE id IN (23,24,25) ORDER BY id")).rows, [{ id: 23 }, { id: 25 }])
    assert.deepEqual((await pool.query('SELECT last_run_at IS NOT NULL AS ran,enabled FROM scheduled_tasks WHERE id=23')).rows,
      [{ ran: true, enabled: false }])
    const stopped = await pool.query("SELECT title,target,content FROM site_notifications WHERE title LIKE '周期到期任务%' ORDER BY id")
    assert.deepEqual(stopped.rows.map(({ title, target }) => ({ title, target })),
      [{ title: '周期到期任务', target: owner }, { title: '周期到期任务（已停用）', target: owner }])
    assert.match(stopped.rows[1]?.content ?? '', /后续不会自动执行/u)
    const unresolved = requests.filter(body => body.includes('合成周期校验失败'))
    assert.ok(unresolved[1]?.includes('已登记停止当前周期任务'), '检查失败前已登记停用意图')
    assert.ok(unresolved.some(body => body.includes('没有 Skill ID 为「U987654」的技能')), '工具失败回执已交付模型')
    assert.equal((await pool.query('SELECT enabled FROM scheduled_tasks WHERE id=26')).rows[0]?.enabled, true)
    const retained = await pool.query("SELECT title,target FROM site_notifications WHERE title LIKE '周期校验失败任务%' ORDER BY id")
    assert.deepEqual(retained.rows, [{ title: '周期校验失败任务', target: owner }])

    await pool.query(`ALTER TABLE user_bots ADD COLUMN id int;
      ALTER TABLE user_bots ADD COLUMN app_id text;
      ALTER TABLE user_bots ADD COLUMN app_secret text;
      ALTER TABLE user_bots ADD COLUMN owner_platform_user_id text;
      ALTER TABLE user_bots ADD COLUMN sandbox boolean;
      CREATE TABLE conversation_sessions(id serial PRIMARY KEY,user_id uuid,source text,bot_id text,chat_type text,chat_id text,
        title text,title_locked boolean,summary text,platform_user_id text,context_epoch int,baseline_message_seq int,
        last_message_seq int DEFAULT 0,execution_state text DEFAULT 'idle',active_run_id text,
        pending_message_count int,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,session_id int,role text,content text,content_json jsonb,
        conversation_seq int,platform_user_id text,platform_user_name text,created_at timestamptz,sent_at timestamptz,
        history_anchor_seq int,covers_until_seq int,run_id text,files jsonb,
        UNIQUE(session_id,conversation_seq));
      CREATE TABLE chat_attachments(user_id uuid,message_id int REFERENCES conversation_messages(id),storage_key text,
        attach_id text,name text,ext text,mime text,size int,extra jsonb,state text,platform text,
        platform_message_id text,attachment_index int,kind text,duration float,img_width int,img_height int,created_at timestamptz,attached_at timestamptz);
      CREATE TABLE interaction_prompts(id int PRIMARY KEY,user_id uuid,session_id int,status text,created_at timestamptz);
      CREATE TABLE memory_scope_tombstones(owner_user_id uuid,platform text,bot_id text,scope_type text,scope_id text)`)
    await pool.query("INSERT INTO user_bots(user_id,platform,enabled,id) VALUES($1,'qq',true,5)", [owner])
    await pool.query(`INSERT INTO conversation_sessions VALUES
      (31,$1,'qq','5','group','synthetic-group'),(32,$1,'qq','6','group','synthetic-group'),
      (33,$1,'qq','5','group','another-group'),(34,$2,'qq','5','group','synthetic-group'),
      (35,$1,'feishu','5','group','synthetic-group')`, [owner, other])
    await pool.query(`INSERT INTO conversation_messages(id,session_id,role,content,content_json,conversation_seq,platform_user_id,platform_user_name,created_at)
      SELECT id,id,'user',CASE WHEN id=31 THEN '合成部署本群证据' ELSE '合成部署隔离证据' END,NULL,1,'synthetic-member','小北',NOW()
      FROM conversation_sessions`)
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed) VALUES
      (27,$1,TRUE,'群历史定时','合成群历史搜索','web,qq',$2,'[]','[]','once',NOW()+interval '1 day',FALSE),
      (28,$1,TRUE,'群历史撤权','合成群历史搜索撤权','web,qq',$2,'[]','[]','once',NOW()+interval '1 day',FALSE)`,
    [owner, { qq: { platform: 'qq', chat_type: 'group', chat_id: 'synthetic-group', channel_id: '5' } }])
    assert.equal((await run(27, owner)).status, 200)
    const groupRequests = requests.filter(body => body.includes('合成群历史搜索'))
    assert.equal(groupRequests.length, 2)
    assert.match(groupRequests[0]!, /group_context_search/u)
    assert.match(groupRequests[1]!, /合成部署本群证据/u)
    assert.doesNotMatch(groupRequests[1]!, /合成部署隔离证据/u)
    assert.equal((await run(28, owner)).status, 200)
    const revokedRequests = requests.filter(body => body.includes('合成群历史搜索撤权'))
    assert.equal(revokedRequests.length, 2)
    assert.match(revokedRequests[1]!, /没有权限使用此工具/u)
    assert.doesNotMatch(revokedRequests[1]!, /合成部署(?:本群|隔离)证据/u)

    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed) VALUES
      (29,$1,TRUE,'预授权邮件','合成邮件工具发送','web','{}','["send_email"]','[]','once',NOW()+interval '1 day',FALSE),
      (30,$1,TRUE,'撤权邮件','合成邮件工具撤权','web','{}','["send_email"]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    assert.equal((await run(29, other)).status, 404)
    assert.equal((await run(29, owner)).status, 200)
    assert.equal((await run(30, owner)).status, 200)
    const sent = requests.filter(body => body.includes('合成邮件工具发送'))
    const denied = requests.filter(body => body.includes('合成邮件工具撤权'))
    assert.equal(sent.length, 2)
    assert.match(sent[1]!, /smtp_accepted/u)
    assert.equal(denied.length, 2)
    assert.match(denied[1]!, /没有权限使用此工具/u)
    assert.deepEqual(receivedRecipients, ['RCPT TO:<owner@example.test>', 'RCPT TO:<owner@example.test>'])
    assert.equal(deliveries.length, 2)
    for (const message of deliveries) {
      assert.match(message, /Subject: Synthetic schedule/u)
      assert.match(message, /Synthetic body/u)
    }
    assert.deepEqual((await pool.query("SELECT method FROM core_operation_receipts WHERE method LIKE 'agent.email.%' ORDER BY method")).rows,
      [{ method: 'agent.email.attempt' }, { method: 'agent.email.attempt' },
        { method: 'agent.email.outcome' }, { method: 'agent.email.outcome' }])

    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_at,last_run_failed) VALUES
      (31,$1,TRUE,'兼容渠道','合成旧 IM 别名','web,im','{}','[]','[]','once',NOW()+interval '1 day',NOW(),TRUE)`, [owner])
    const alias = await run(31, owner)
    assert.equal(alias.status, 200)
    assert.deepEqual((await alias.json()).result, {
      'web 通知': '已发送',
      QQ: '无可触达地址（先给该 bot 发条消息）',
      飞书: '无可触达地址（先给该 bot 发条消息）',
      微信: '无可触达地址（先给该 bot 发条消息）',
      Telegram: '无可触达地址（先给该 bot 发条消息）',
    })
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM site_notifications WHERE title='兼容渠道' AND target=$1", [owner])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT last_run_failed FROM scheduled_tasks WHERE id=31')).rows[0]?.last_run_failed, true)

    await pool.query(`INSERT INTO user_bots(id,user_id,platform,enabled,app_id,app_secret)
      VALUES(6,$1,'wechat',true,'https://ilinkai.weixin.qq.com',$2)`,
    [owner, encryptEncryptedString(secret, 'synthetic-wechat-token')])
    const reach = `imreach:${owner}:wechat`
    reachKeys.push(reach)
    assert.equal(await redis.saveIfAbsent(reach, JSON.stringify({
      platform: 'wechat', channel_id: 6, chat_type: 'c2c', puid: 'synthetic-private', context_token: 'synthetic-context',
    }), 60), true)
    const binding = `im:owner-session:${owner}:wechat:synthetic-private:6`
    reachKeys.push(binding)
    assert.equal(await redis.saveIfAbsent(binding, '36', 60), true)
    await pool.query(`INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,chat_id,platform_user_id,last_message_seq,updated_at)
      VALUES(36,$1,'web',NULL,NULL,NULL,NULL,7,now()-interval '1 day'),
      (37,$1,'wechat','6','c2c',NULL,'synthetic-private',0,now()),
      (38,$2,'wechat','6','c2c',NULL,'synthetic-private',0,now())`, [owner, other])
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed) VALUES
      (32,$1,TRUE,'旧私聊','旧 IM 私聊正文','im,wechat','{}','[]','[]','once',NOW()+interval '1 day',FALSE),
      (33,$1,TRUE,'无效目标','旧 IM 固定目标正文','im','{"wechat":null}','[]','[]','once',NOW()+interval '1 day',FALSE),
      (34,$1,TRUE,'未连接的显式渠道','合成 Telegram 正文','im,telegram','{}','[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    const privateRun = await run(32, owner)
    assert.equal(privateRun.status, 200)
    assert.equal((await privateRun.json()).result.微信, '已发送')
    const missingFixed = await run(33, owner)
    assert.equal(missingFixed.status, 200)
    assert.equal((await missingFixed.json()).result.微信, '无可触达地址（先给该 bot 发条消息）')
    const unsupported = await run(34, owner)
    assert.equal(unsupported.status, 200)
    assert.deepEqual((await unsupported.json()).result, { 错误: '任务执行失败' })
    assert.equal(wechatMessages.length, 1)
    assert.partialDeepStrictEqual(wechatMessages[0], {
      to_user_id: 'synthetic-private', context_token: 'synthetic-context',
      item_list: [{ type: 1, text_item: { text: '⏰ 旧私聊\n\n定时工作已完成' } }],
    })
    const preview: LightMyRequestResponse = await host.app.inject({
      method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers: auth, payload: { channels: ['im'], name: '兼容测试' },
    })
    assert.equal(preview.statusCode, 200)
    assert.equal(preview.json().result.微信, '已发送')
    assert.equal(wechatMessages.length, 2)
    assert.deepEqual((await pool.query(`SELECT session_id,conversation_seq,role,content FROM conversation_messages
      WHERE session_id IN (36,37,38) ORDER BY session_id,conversation_seq`)).rows, [{
      session_id: 36, conversation_seq: 8, role: 'assistant', content: '⏰ 旧私聊\n\n定时工作已完成',
    }, {
      session_id: 36, conversation_seq: 9, role: 'assistant',
      content: '⏰ 兼容测试（测试）\n\n这是一条测试提醒——「兼容测试」。如果你收到了这条消息，说明提醒渠道工作正常。',
    }])
    assert.equal(await redis.get(binding), '36')
    await redis.delete(binding)
    assert.equal(await redis.saveIfAbsent(binding, '38', 60), true)
    const recovered = await run(32, owner)
    assert.equal(recovered.status, 200)
    assert.equal((await recovered.json()).result.微信, '已发送')
    assert.equal(await redis.get(binding), '37')
    assert.deepEqual((await pool.query(`SELECT session_id,count(*)::int AS count FROM conversation_messages
      WHERE session_id IN (36,37,38) GROUP BY session_id ORDER BY session_id`)).rows,
    [{ session_id: 36, count: 2 }, { session_id: 37, count: 1 }])

    await pool.query("UPDATE conversation_sessions SET last_message_seq=2002 WHERE id=37")
    await pool.query("UPDATE conversation_messages SET role='user',run_id='im-pending:synthetic' WHERE session_id=37 AND conversation_seq=1")
    await pool.query(`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at,covers_until_seq)
      SELECT 5000+seq,37,seq,CASE WHEN seq=2002 THEN 'summary' ELSE 'user' END,'合成历史',now()-interval '1 day',
        CASE WHEN seq=2002 THEN 24 ELSE NULL END FROM generate_series(2,2002) seq`)
    const orphan = `${owner}/.chat_staging/synthetic-orphan.txt`
    const shared = `${owner}/.chat_staging/synthetic-shared.txt`
    for (const object of [orphan, shared]) {
      const path = join(root, 'storage', object)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '合成附件')
    }
    await pool.query(`INSERT INTO chat_attachments(user_id,message_id,storage_key) VALUES($1,5002,$2),($1,5003,$3),($1,7001,$3)`, [owner, orphan, shared])
    await pool.query(`INSERT INTO interaction_prompts VALUES
      (1,$1,37,'resolved',now()-interval '3 days'),(2,$1,37,'active',now()-interval '3 days'),
      (3,$1,37,'cancelled',now()),(4,$2,38,'resolved',now()-interval '3 days')`, [owner, other])
    const trimmed = await run(32, owner)
    assert.equal(trimmed.status, 200)
    assert.equal((await trimmed.json()).result.微信, '已发送')
    assert.deepEqual((await pool.query(`SELECT conversation_seq FROM conversation_messages
      WHERE session_id=37 AND conversation_seq<=4 ORDER BY conversation_seq`)).rows,
    [{ conversation_seq: 1 }, { conversation_seq: 4 }])
    assert.deepEqual((await pool.query('SELECT message_id FROM chat_attachments ORDER BY message_id')).rows, [{ message_id: 7001 }])
    await assert.rejects(readFile(join(root, 'storage', orphan)), { code: 'ENOENT' })
    assert.equal(await readFile(join(root, 'storage', shared), 'utf8'), '合成附件')
    assert.deepEqual((await pool.query('SELECT id FROM interaction_prompts ORDER BY id')).rows, [{ id: 2 }, { id: 3 }, { id: 4 }])
    await redis.delete(reach)
    assert.equal(await redis.saveIfAbsent(reach, JSON.stringify({
      platform: 'wechat', channel_id: 6, chat_type: 'group', chat_id: 'synthetic-recent-group',
      puid: 'synthetic-private', context_token: 'synthetic-context',
    }), 60), true)
    const recentGroup = await run(32, owner)
    assert.equal(recentGroup.status, 200)
    assert.equal((await recentGroup.json()).result.微信, '无可触达地址（先给该 bot 发条消息）')
    assert.equal(wechatMessages.length, 4)

    const report = `${owner}/personal/synthetic-schedule.txt`
    const reportPath = join(root, 'storage', report)
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, 'synthetic scheduled attachment')
    await pool.query(`INSERT INTO files(id,user_id,display_name,ext,space,storage_key,storage_backend,size_bytes,mime_type)
      VALUES(7,$1,'synthetic-schedule','txt','personal',$3,'local',30,'text/plain'),
      (8,$2,'synthetic-foreign','txt','personal',$4,'local',20,'text/plain')`, [owner, other, report, `${other}/personal/foreign.txt`])
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed) VALUES
      (35,$1,TRUE,'定时附件邮件','合成定时附件发送','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE),
      (36,$1,TRUE,'异主附件邮件','合成定时附件异主','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    const sendArtifact = await run(35, owner)
    assert.equal(sendArtifact.status, 200)
    assert.deepEqual((await sendArtifact.json()).result, { 邮件: '已发送' })
    assert.ok(/filename="?synthetic-schedule\.txt/u.test(deliveries.at(-1) ?? ''), 'SMTP 邮件应包含命名附件')
    assert.ok((deliveries.at(-1) ?? '').includes('c3ludGhldGljIHNjaGVkdWxlZCBhdHRhY2htZW50'), '附件字节应与 owner 文件一致')
    const ownTrace = requests.filter(request => scheduledPrompt(request).includes('合成定时附件发送'))
    assert.match(ownTrace[0] ?? '', /"name":"send_file"/u)
    assert.match(ownTrace[1] ?? '', /已准备好/u)
    const foreignArtifact = await run(36, owner)
    assert.equal(foreignArtifact.status, 200)
    assert.doesNotMatch(deliveries.at(-1) ?? '', /Content-Disposition: attachment/u)
    const foreignTrace = requests.filter(request => scheduledPrompt(request).includes('合成定时附件异主'))
    assert.match(foreignTrace[1] ?? '', /文件不存在/u)
    assert.doesNotMatch(foreignTrace[1] ?? '', /synthetic-foreign|foreign\.txt/u)

    const staged = `${owner}/.chat_staging/staged-image.png`
    await writeFile(join(root, 'storage', staged), 'synthetic image bytes')
    await pool.query(`INSERT INTO chat_attachments(user_id,storage_key,attach_id,name,ext,mime,size)
      VALUES($1,$2,'synthetic-staged-image','staged-image','png','image/png',21)`, [owner, staged])
    await pool.query(`INSERT INTO user_bots(id,user_id,platform,enabled,app_id,app_secret)
      VALUES(7,$1,'feishu',true,'cli_synthetic',$2)`, [owner, encryptEncryptedString(secret, 'synthetic-feishu-secret')])
    await pool.query(`INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,chat_id)
      VALUES(39,$1,'feishu','7','group','oc_synthetic')`, [owner])
    reachKeys.push('imsession:feishu:7:oc_synthetic')
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_at,last_run_failed)
      VALUES(37,$1,TRUE,'飞书附件','合成定时附件飞书','feishu',
      '{"feishu":{"platform":"feishu","channel_id":"7","chat_type":"group","chat_id":"oc_synthetic"}}',
      '[]','[]','once',NOW()+interval '1 day',NOW(),TRUE)`, [owner])
    const feishuArtifact = await run(37, owner)
    assert.equal(feishuArtifact.status, 200)
    assert.deepEqual((await feishuArtifact.json()).result, { 飞书: '文字已发送，附件发送失败（1/2）' })
    assert.deepEqual(feishuUploads.map(upload => upload.path).sort(), ['/open-apis/im/v1/files', '/open-apis/im/v1/images'])
    assert.ok(feishuUploads.some(upload => upload.body.includes('synthetic-report.txt') && upload.body.includes('synthetic scheduled attachment')))
    assert.ok(feishuUploads.some(upload => upload.body.includes('synthetic image bytes')))
    assert.deepEqual(feishuMessages.map(message => [message.receive_id, message.msg_type]), [['oc_synthetic', 'text'], ['oc_synthetic', 'file']])
    assert.equal((await pool.query('SELECT last_run_failed FROM scheduled_tasks WHERE id=37')).rows[0]?.last_run_failed, true)
    const cards = (await pool.query('SELECT files FROM conversation_messages WHERE session_id=39')).rows[0]?.files as Array<Record<string, unknown>>
    assert.deepEqual(cards.map(card => card.file_id ?? card.attach_id).sort(), [7, 'synthetic-staged-image'])
    rejectFeishuImage = false
    const feishuRetry = await run(37, owner)
    assert.equal(feishuRetry.status, 200)
    assert.deepEqual((await feishuRetry.json()).result, { 飞书: '已发送' })
    assert.deepEqual(feishuMessages.slice(2).map(message => [message.receive_id, message.msg_type]),
      [['oc_synthetic', 'text'], ['oc_synthetic', 'file'], ['oc_synthetic', 'image']])
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=37')).rowCount, 0)

    await writeFile(config, JSON.stringify({ im: { qq: true } }))
    await pool.query(`INSERT INTO user_bots(id,user_id,platform,enabled,app_id,app_secret,sandbox)
      VALUES(8,$1,'qq',true,'synthetic-qq-app',$2,false)`, [owner, encryptEncryptedString(secret, 'synthetic-qq-secret')])
    await pool.query(`INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,chat_id)
      VALUES(40,$1,'qq','8','group','synthetic-qq-group')`, [owner])
    reachKeys.push('imsession:qq:8:synthetic-qq-group')
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed)
      VALUES(38,$1,TRUE,'QQ 附件','合成定时附件 QQ','qq',
      '{"qq":{"platform":"qq","channel_id":"8","chat_type":"group","chat_id":"synthetic-qq-group"}}',
      '[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    const qqResult = await run(38, owner)
    assert.equal(qqResult.status, 200)
    assert.deepEqual((await qqResult.json()).result, { QQ: '已发送' })
    assert.deepEqual([...qqParts.keys()].sort(), ['/synthetic-part-1', '/synthetic-part-2'])
    assert.equal(qqParts.get('/synthetic-part-1')! + qqParts.get('/synthetic-part-2')!, 'synthetic scheduled attachment')
    assert.equal(qqCalls.filter(item => item.path.endsWith('/upload_part_finish')).length, 2)
    assert.deepEqual(qqCalls.at(-1)?.body, { msg_type: 7, msg_seq: 1, media: { file_info: 'synthetic-qq-file' }, content: 'synthetic-schedule.txt' })
    const content = qqCalls.find(item => item.path.endsWith('/upload_prepare'))?.body
    assert.equal(content?.file_size, 30)
    assert.equal(content?.file_type, 4)
    assert.equal(content?.md5, createHash('md5').update('synthetic scheduled attachment').digest('hex'))
    assert.equal(content?.sha1, createHash('sha1').update('synthetic scheduled attachment').digest('hex'))
    assert.equal(content?.file_data, undefined)
    qqParts.clear()
    unsafeQqUpload = true
    const blockedQq = await run(38, owner)
    assert.deepEqual((await blockedQq.json()).result, { QQ: '文字已发送，附件发送失败（0/1）' })
    assert.equal(qqParts.size, 0)
    assert.equal(qqCalls.filter(item => item.body.msg_type === 7).length, 1)

    unsafeQqUpload = false
    qqFileMessageHasAck = false
    const beforeUnknown = qqCalls.length
    const unknownQq = await run(38, owner)
    assert.deepEqual((await unknownQq.json()).result, { QQ: '文字已发送，附件发送失败（0/1）' })
    assert.equal(qqCalls.slice(beforeUnknown).filter(item => item.body.msg_type === 7).length, 1)
    assert.equal(qqCalls.slice(beforeUnknown).filter(item => item.path.endsWith('/upload_prepare')).length, 1)
    qqFileMessageHasAck = true
    revokeQqAfterUpload = true
    const beforeRevoke = qqCalls.length
    const revokedQq = await run(38, owner)
    assert.deepEqual((await revokedQq.json()).result, { QQ: '文字已发送，附件发送失败（0/1）' })
    assert.ok(qqCalls.slice(beforeRevoke).some(item => item.path.endsWith('/files')))
    assert.equal(qqCalls.slice(beforeRevoke).filter(item => item.body.msg_type === 7).length, 0)

    await redis.delete(reach)
    assert.equal(await redis.saveIfAbsent(reach, JSON.stringify({
      platform: 'wechat', channel_id: 6, chat_type: 'c2c', puid: 'synthetic-private', context_token: 'synthetic-context',
    }), 60), true)
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed)
      VALUES(39,$1,TRUE,'微信附件','合成定时附件微信','wechat','{}','[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    wechatRefreshReach = reach
    const wechatResult = await run(39, owner)
    assert.equal(wechatResult.status, 200)
    assert.deepEqual((await wechatResult.json()).result, { 微信: '已发送' })
    assert.deepEqual(wechatTickets.map(ticket => ticket.media_type), [3, 1])
    assert.equal(wechatUploads.length, 3)
    assert.deepEqual(wechatUploads[0], wechatUploads[1])
    assert.equal(wechatUploadPaths[0], wechatUploadPaths[1])
    assert.match(wechatUploadPaths[2]!, /^\/c2c\/upload\?encrypted_query_param=synthetic-ticket&filekey=[a-f0-9]{32}$/u)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(String(wechatTickets[0]?.aeskey), 'hex'), null)
    assert.equal(Buffer.concat([decipher.update(wechatUploads[1]!), decipher.final()]).toString(), 'synthetic scheduled attachment')
    assert.partialDeepStrictEqual(wechatMessages.at(-2), { context_token: 'synthetic-fresh-context', item_list: [{
      type: 4, file_item: { file_name: 'synthetic-report.txt', len: '30', media: {
        encrypt_query_param: 'synthetic-cdn-receipt',
        aes_key: Buffer.from(String(wechatTickets[0]?.aeskey), 'utf8').toString('base64'), encrypt_type: 1,
      } },
    }] })
    assert.partialDeepStrictEqual(wechatMessages.at(-1), { item_list: [{ type: 2, image_item: { mid_size: wechatUploads[2]?.length } }] })

    invalidWechatUpload = true
    const invalidMedia = await run(39, owner)
    assert.deepEqual((await invalidMedia.json()).result, { 微信: '文字已发送，附件发送失败（0/2）' })
    assert.equal(wechatUploads.length, 3)
    invalidWechatUpload = false
    rejectedWechatFile = true
    const beforeRejection = wechatMessages.length
    const rejectedMedia = await run(39, owner)
    assert.deepEqual((await rejectedMedia.json()).result, { 微信: '文字已发送，附件发送失败（1/2）' })
    assert.deepEqual(wechatMessages.slice(beforeRejection).map(message =>
      (message as { item_list: { type: number }[] }).item_list[0]?.type), [1, 4, 2])

    await writeFile(config, JSON.stringify({ im: { qq: true },
      safe_egress: { enabled: true, proxy_url: `http://127.0.0.1:${proxyAddress.port}` } }))
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed)
      VALUES(40,$1,TRUE,'网络图片','合成定时附件 URL','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE),
      (41,$1,TRUE,'私网跳转','合成定时附件 URL 私网','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE),
      (42,$1,TRUE,'下载时停用','合成定时附件 URL 停用','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    const remote = await run(40, owner)
    assert.equal(remote.status, 200)
    assert.deepEqual((await remote.json()).result, { 邮件: '已发送' },
      `合成图片连接数 ${fetchedImagePaths.length}，模型轮数 ${requests.filter(request => scheduledPrompt(request).includes('合成定时附件 URL')).length}`)
    assert.ok(/filename="?synthetic-remote\.png/u.test(deliveries.at(-1) ?? ''), '邮件应包含暂存的远程图片')
    assert.deepEqual(fetchedImagePaths, ['/redirect', '/image.png'])
    const stagedRemote = (await pool.query(`SELECT storage_key,name,kind,img_width,img_height FROM chat_attachments
      WHERE user_id=$1 AND name='synthetic-remote'`, [owner])).rows
    assert.equal(stagedRemote.length, 1)
    assert.partialDeepStrictEqual(stagedRemote[0], { name: 'synthetic-remote', kind: 'image', img_width: 1, img_height: 1 })
    assert.deepEqual(await readFile(join(root, 'storage', stagedRemote[0].storage_key)), remoteImage)
    const beforeBlocked = proxyTargets.length
    const blockedRemote = await run(41, owner)
    assert.equal(blockedRemote.status, 200)
    assert.deepEqual(fetchedImagePaths, ['/redirect', '/image.png', '/private-redirect'])
    assert.ok(!proxyTargets.slice(beforeBlocked).includes('127.0.0.1:443'))
    assert.doesNotMatch(deliveries.at(-1) ?? '', /filename="?synthetic-remote\.png/u)
    assert.match(requests.filter(request => scheduledPrompt(request).includes('合成定时附件 URL 私网')).at(-1) ?? '', /这个链接发不了/u)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_attachments WHERE user_id=$1 AND name=$2',
      [owner, 'synthetic-remote'])).rows[0].count, 1)
    const disabledRemote = await run(42, owner)
    assert.equal(disabledRemote.status, 200)
    assert.equal(fetchedImagePaths.at(-1), '/disable-after-fetch')
    assert.match(requests.filter(request => scheduledPrompt(request).includes('合成定时附件 URL 停用')).at(-1) ?? '', /定时任务工具授权已失效/u)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_attachments WHERE user_id=$1 AND name=$2',
      [owner, 'synthetic-remote'])).rows[0].count, 1)

    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,schedule_kind,start_at,last_run_failed)
      VALUES(43,$1,TRUE,'到期网络图片','合成定时附件 URL 到期','email','{}','[]','[]','once',NOW()+interval '1 day',FALSE)`, [owner])
    const updated = await host.app.inject({ method: 'PATCH', url: '/api/v1/scheduled-tasks/43', headers: auth,
      payload: { start_at: new Date(Date.now() + 3000).toISOString() } })
    assert.equal(updated.statusCode, 200, updated.body)
    const workerDeadline = Date.now() + 15000
    while (Date.now() < workerDeadline && (await pool.query('SELECT id FROM scheduled_tasks WHERE id=43')).rowCount)
      await delay(100)
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=43')).rowCount, 0)
    assert.equal(deliveries.filter(message => /filename="?synthetic-remote-worker\.png/u.test(message)).length, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_attachments WHERE user_id=$1 AND name=$2',
      [owner, 'synthetic-remote-worker'])).rows[0].count, 1)
  } finally {
    dns.lookup = originalLookup
    syncBuiltinESMExports()
    setDefaultCACertificates(defaultCAs)
    await host?.close()
    for (const address of reachKeys) await redis.delete(address)
    for (const tunnel of tunnels) tunnel.destroy()
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()))
    if (relay) await new Promise<void>(resolve => relay!.close(() => resolve()))
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    if (smtp) await new Promise<void>(resolve => smtp!.close(() => resolve()))
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
    await rm(root, { recursive: true, force: true })
  }
})
