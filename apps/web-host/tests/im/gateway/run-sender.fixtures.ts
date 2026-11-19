import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import { resolveImActor, type ImPlatform } from '@gugu/core/im/access'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound-envelope.js'
import { imConversationDigest, imConversationFingerprint, imConversationScopeHash } from '../../../src/modules/im/gateway/conversation-identity.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../../../src/modules/im/gateway/attachment-ingress.js'
import type { GatewayPlatformSender } from '../../../src/modules/im/gateway/platform-connections.js'
import { createTelegramSender } from '../../../src/modules/im/gateway/telegram-sender.js'
import { createTelegramBotApi } from '../../../src/modules/im/gateway/telegram-api.js'
import { createFeishuClient } from '../../../src/modules/im/gateway/feishu/client.js'
import { createFeishuSender } from '../../../src/modules/im/gateway/feishu/sender.js'
import { createFeishuStreamingSender } from '../../../src/modules/im/gateway/feishu/streaming.js'
import { createQqClient } from '../../../src/modules/im/gateway/qq/client.js'
import { createQqSender } from '../../../src/modules/im/gateway/qq/sender.js'
import { createQqMediaUploader } from '../../../src/modules/im/gateway/qq/media-upload.js'
import { createILinkClient } from '../../../src/modules/im/gateway/wechat/client.js'
import { createWechatMedia } from '../../../src/modules/im/gateway/wechat/media.js'
import { createWechatSender } from '../../../src/modules/im/gateway/wechat/sender.js'

export const owner = '00000000-0000-4000-8000-000000000091', other = '00000000-0000-4000-8000-000000000092'
export const data = Buffer.from('synthetic authorized local artifact')
export const secretKey = 'synthetic-run-scope-secret'
export const stored = `${owner}/.chat_staging/synthetic.txt`
export const deliveryOutcome = (value: unknown) => value && typeof value === 'object' && 'outcome' in value ? value.outcome : value
export function context(platform: ImPlatform = 'telegram', member = false) {
  const scope: ImAttachmentScope = { ownerId: owner, platform, botId: '91', chatType: 'c2c', chatId: null, platformUserId: platform === 'telegram' ? '202' : platform === 'feishu' ? 'ou_synthetic_sender' : 'synthetic_sender' }
  return { secretKey, identity: { ownerId: owner, sessionId: '91', runId: `synthetic-${platform}` }, scope,
    actor: resolveImActor({ ...scope, botMentioned: true, mentionsOtherBot: false }, () => ({ role: member ? 'member' : 'owner', allowedToolNames: member ? ['read_file','send_file'] : null })),
    payload: { owner_user_id: owner, platform, bot_id: '91', channel_id: '91', chat_type: scope.chatType, platform_user_id: scope.platformUserId, chat_id: 'oc_synthetic',
      context_token: 'synthetic-reply-context', message_id: platform === 'wechat' ? 'synthetic-reply-context' : '31',
      ...(platform === 'wechat' ? {} : { platform_message_id: '31' }), _node_stream_event_id: '1791000000000-1', text: 'synthetic inbound' } }
}
export function receipt(c: ReturnType<typeof context>) {
  const binding = { ownerId: c.scope.ownerId, platform: c.scope.platform, botId: c.scope.botId }, scopeHash = imConversationScopeHash(c.secretKey, binding, c.payload)
  return { scope_hash: scopeHash, event_hash: imConversationDigest(c.secretKey, [scopeHash, c.scope.platformUserId, c.payload.message_id]),
    fingerprint: imConversationFingerprint(c.secretKey, scopeHash, c.payload, []), sealed_payload: createImInboundEnvelope(c.secretKey).seal(binding, c.payload),
    platform_user_id: c.scope.platformUserId, im_platform_message_id: c.scope.platform === 'wechat' ? null : c.payload.message_id }
}
export function platform(kind: ImPlatform, hook?: (request: ProviderHttpRequest) => void | Promise<void>, passiveSequences = false) {
  const requests: ProviderHttpRequest[] = []
  const transport: ProviderTransport = { async request(request) {
    requests.push(request); await hook?.(request)
    const path = new URL(request.url).pathname
    let result: unknown = {}
    if (kind === 'telegram') result = { ok: true, result: { message_id: 11 } }
    if (kind === 'feishu') result = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }
      : path.endsWith('/files') ? { code: 0, data: { file_key: 'synthetic-file-key' } } : { code: 0, data: { message_id: 'om_synthetic' } }
    if (kind === 'qq') result = path.includes('getAppAccessToken') ? { access_token: 'synthetic-qq-token', expires_in: 7200 }
      : path.endsWith('/upload_prepare') ? { upload_id: 'synthetic-upload', block_size: data.length, parts: [{ index: 1, presigned_url: 'https://synthetic-bucket.myqcloud.com/part?q-signature=synthetic-signature' }] }
        : path.endsWith('/files') ? { file_info: 'synthetic-file-info' } : path.endsWith('/messages') ? { id: 'synthetic-message' } : {}
    if (kind === 'wechat') result = path.endsWith('/getuploadurl') ? { ret: 0, upload_param: 'synthetic-upload-param' } : { ret: 0 }
    const headers: Record<string, string> = kind === 'wechat' && path === '/c2c/upload' ? { 'x-encrypted-param': 'synthetic-download-param' } : {}
    return { status: 200, headers,
      body: (async function* () { yield Buffer.from(JSON.stringify(result)) })(), cancel() {} }
  }, async close() {} }
  let sender: GatewayPlatformSender, close: () => Promise<void>
  if (kind === 'telegram') {
    const api = createTelegramBotApi({ transport })
    sender = { platform: kind, sender: createTelegramSender({ token: '12345:synthetic_telegram_token_abcdefghijklmnop', api, sleep: async () => {} }) }; close = () => api.close()
  } else if (kind === 'feishu') {
    const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport })
    sender = { platform: kind, sender: createFeishuSender({ client }), streaming: createFeishuStreamingSender({ client }) }; close = () => client.close()
  } else if (kind === 'qq') {
    const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox: false, transport })
    const mediaUpload = createQqMediaUploader({ client, transport })
    sender = { platform: kind, mediaUpload, sender: createQqSender({ client, botId: '91', sanitizeText: text => text,
      sequences: { async nextPassive() { if (!passiveSequences) assert.fail('主动制品不应消耗被动序号'); return 1 }, async nextStream() { assert.fail('不应建流') } } }) }
    close = async () => { await mediaUpload.close(); await client.close() }
  } else {
    const client = createILinkClient({ botToken: 'synthetic-wechat-token', transport }), media = createWechatMedia({ client, transport })
    const out = createWechatSender({ client, media }); sender = { platform: kind, sender: out }
    close = async () => { await out.close(); await media.close(); await client.close() }
  }
  return { sender, requests, close }
}
export async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-artifact-'))
  try { await mkdir(dirname(join(root, stored)), { recursive: true }); await writeFile(join(root, stored), data); await work(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}
export function fakeDatabase(c = context()) {
  let sequence = 3, scopeKey = imAttachmentScopeKey(c.scope), key = stored, queries = 0
  const pool = { async query(sql: string) { queries++
    if (sql.includes('gugu_im_inbound_receipts')) return { rows: [{ id: '11', conversation_seq: '3', ...receipt(c) }] }
    if (sql.includes('FROM chat_attachments')) return { rows: [{ name: '合成报告', ext: 'txt', mime: 'text/plain', size: data.length,
      storage_key: key, extra: { im_ingress_scope: scopeKey }, conversation_seq: sequence }] }
    throw new Error('synthetic-private-unexpected-query')
  } } as unknown as Pool
  return { pool, queries: () => queries, later() { sequence = 4 }, wrongScope() { scopeKey = 'another-group' }, otherOwner() { key = `${other}/private.txt` } }
}
