import { replacePlatformMentionIds } from '@gugu/core/agent/context/messages'
import type { Pool, PoolClient } from 'pg';
import { normalizePersistentArtifact, stableJson } from '@gugu/core/agent';
import type { RunIdentity } from '@gugu/core/agent';
import { aggregateImInboundPayloads, partitionImInboundBatch } from '@gugu/core/im/inbound-batch';
import { normalizeOwnerId } from '../../../../shared/owner-context.js';
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js';
import { createImInboundEnvelope } from '../inbound/envelope.js';
import type { NodeImBotBinding } from '../inbound/inbox.js';
import { imConversationEventId, imConversationDigest, imConversationFingerprint, imConversationScopeHash } from './identity.js';
import { parseImAttentionRecord, type ImAttentionRecord } from '@gugu/core/im/attention/directive';
import type { ImRetiredInboundKey } from '../inbound/retired.js';

type Payload = Record<string, unknown>;
// 群聊用群 ID，私聊用联系人 ID；历史记录的 chat_type 可为空。
export const imSessionScopeSql = `user_id=$1 AND source=$2 AND bot_id=$3
  AND (CASE WHEN $4::text IS NOT NULL THEN chat_id=$4 ELSE chat_id IS NULL AND platform_user_id=$5 END)`;
export interface ImConversationAnchor {
  sessionId: number; messageId: number; conversationSeq: number;
  runId: string | null; duplicate: boolean; isNewSession: boolean;
  /** 已确认的被动消息不能因普通事件重投/配置放宽而升级成新Run。 */
  recordedPassive?: true;
}
export interface ImConversationPersistInput {
  eventId: string; mode: 'early' | 'passive' | 'dispatch'; sessionId?: number;
  /** 借用同事务登记startup/派发并返回真实runId；不得自行COMMIT或运行Provider。 */
  onDispatch?(client: PoolClient, anchor: ImConversationAnchor): Promise<string>;
}
export interface ImConversationBatchItem { eventId: string; payload: Payload }
export interface ImConversationSegment {
  batchKey: string; segmentKey: string; index: number; anchors: ImConversationAnchor[];
  aggregate: Payload; runId: string | null; duplicate: boolean;
}
interface SegmentRow {
  sequence: string | number;
  user_id: string; platform: NodeImBotBinding['platform']; bot_id: string; chat_type: 'c2c' | 'group';
  scope_hash: string; segment_key: string; batch_key: string; segment_index: number; session_id: number;
  state: 'started' | 'completed'; mode: 'dispatch' | 'passive'; run_id: string | null;
  anchors: ImConversationAnchor[]; sealed_payload: Payload;
}
export type ImConversationAttachments = { mode: 'text-only' } | {
  mode: 'enabled';
  /** 必须同事务验证每个附件owner、状态和过期时间；早落库只读卡片，不claim。 */
  resolve(client: PoolClient, ownerId: string, attachmentIds: readonly string[]): Promise<readonly Record<string, unknown>[]>;
  claim(client: PoolClient, ownerId: string, messageId: number, attachmentIds: readonly string[]): Promise<void>;
};
export class ImConversationError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthorized' | 'conflict' | 'not_found' | 'storage_failure', options?: ErrorOptions) { super('IM 会话持久化未完成', options); this.name = 'ImConversationError'; }
}
const object = (value: unknown): value is Payload => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ImConversationError('invalid_input');
  return value;
}
function positive(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647) throw new ImConversationError('conflict');
  return parsed;
}
function optionalText(value: unknown, max: number): string | null { return value == null || value === '' ? null : identifier(value, max); }
function millis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ImConversationError('invalid_input');
  return value;
}
/** 只接受Host传入的真实队列ID；网络载荷同名字段没有身份效力。 */
function captureNodeStreamEvent(payload: Payload, eventId: string): void {
  delete payload._node_stream_event_id;
  delete payload._node_attention;
  delete payload._node_attention_required;
  delete payload._node_pending_ask_resume_id;
  if (/^\d+-\d+$/.test(eventId)) payload._node_stream_event_id = eventId;
}
interface ReceiptRow {
  fingerprint: string; session_id: number; message_id: number; conversation_seq: string;
  state: 'staged' | 'passive' | 'dispatched'; run_id: string | null; sealed_payload: Payload; batched?: boolean;
}

/** 使用既有会话/消息表；新增表只保存入站收据及密封回复材料，不复制聊天历史。 */
export function createPostgresImConversationStore(options: {
  pool: Pick<Pool, 'connect' | 'query'>; secretKey: string; attachments: ImConversationAttachments;
  /** 每次调用（含重复和恢复）均从当前账户/Bot配置复核，不信任payload权限字段。 */
  authorize(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>): Promise<boolean>;
  /** 复用共享群策略及控制命令分流；不能根据模型或不可信payload自行升级为reply。 */
  classify(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>): Promise<'reply' | 'passive' | 'control'>;
  /** 可信服务仅在当前确为owner私聊时返回显式Web绑定；请求参数不得直接充当该结果。 */
  ownerSession?(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>): Promise<number | null>;
  /** 会话上限/清理沿用Host既有服务；不能由本适配器擅自删除历史。 */
  beforeCreate?(client: PoolClient, ownerId: string): Promise<void>;
  /** 已物理裁剪的事件仍永久消费；不能依赖指向旧消息的级联收据。 */
  retired?(client: PoolClient, key: ImRetiredInboundKey): Promise<boolean>;
  /** 仅在事务提交后发送资源失效通知，不发送聊天正文或附件名。 */
  afterCommit?(ownerId: string, sessionId: number): Promise<void>;
  /** 所有锚点/收据已转为dispatched后的同事务绑定；不得执行网络请求或自行COMMIT。 */
  afterDispatch?(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>, identity: RunIdentity, messageIds: readonly string[]): Promise<void>;
  /** 最终passive收据已提交到本事务；只登记Node反思事实，不请求模型。 */
  afterPassive?(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly string[]):Promise<void>;
}) {
  const envelope = createImInboundEnvelope(options.secretKey);
  const digest = (value: unknown) => imConversationDigest(options.secretKey, value);
  const mapped = (value: unknown) => value instanceof ImConversationError ? value : new ImConversationError('storage_failure', { cause: value });
  function normalize(binding: NodeImBotBinding, input: Payload) {
    const owner = normalizeOwnerId(binding.ownerId);
    if (owner !== binding.ownerId || !['feishu', 'qq', 'wechat', 'telegram'].includes(binding.platform) || !/^[1-9]\d*$/.test(binding.botId)) throw new ImConversationError('invalid_input');
    const payload: unknown = JSON.parse(JSON.stringify(input));
    if (!object(payload) || payload.platform !== binding.platform || payload.owner_user_id !== owner || payload.bot_id !== undefined && payload.bot_id !== binding.botId || payload.channel_id !== undefined && payload.channel_id !== binding.botId || !['group', 'c2c'].includes(String(payload.chat_type))) throw new ImConversationError('invalid_input');
    const sender = identifier(payload.platform_user_id), type = payload.chat_type as 'group' | 'c2c';
    const chat = type === 'group' ? identifier(payload.chat_id) : null;
    identifier(payload.message_id, 8192);
    if (typeof payload.text !== 'string' || payload.text.length > 1_000_000) throw new ImConversationError('invalid_input');
    if (payload.attachments != null && !Array.isArray(payload.attachments)) throw new ImConversationError('invalid_input');
    const ids = (payload.attachments as unknown[] | undefined ?? []).map(item => typeof item === 'string' ? identifier(item, 256) : object(item) && typeof item.attach_id === 'string' ? identifier(item.attach_id, 256) : null);
    if (ids.some(id => id === null)) return { pendingMedia: true as const };
    if (new Set(ids).size !== ids.length || !payload.text.trim() && !ids.length) throw new ImConversationError('invalid_input');
    const value: Payload = { ...payload, bot_id: binding.botId, channel_id: binding.botId };
    const scopeHash = imConversationScopeHash(options.secretKey, binding, payload);
    const eventHash = digest([scopeHash, sender, imConversationEventId(payload)]);
    const fingerprint = imConversationFingerprint(options.secretKey, scopeHash, payload, ids as string[]);
    return { pendingMedia: false as const, value, ids: ids as string[], sender, type, chat, scopeHash, eventHash, fingerprint };
  }
  async function locked<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try { return await withPostgresTransaction(options.pool, work, mapped); } catch (value) { throw mapped(value); }
  }
  async function persistLocked(client: PoolClient, binding: NodeImBotBinding, payload: Payload,
    input: Omit<ImConversationPersistInput, 'mode'> & { mode: ImConversationPersistInput['mode'] | 'stage'; expectedClass?: 'reply' | 'passive' }): Promise<ImConversationAnchor | null> {
      let prepared: ReturnType<typeof normalize>;
      try { prepared = normalize(binding, payload); identifier(input.eventId, 8192); }
      catch { throw new ImConversationError('invalid_input'); }
      if (!['early', 'passive', 'dispatch', 'stage'].includes(input.mode) || input.mode === 'dispatch' && !input.onDispatch) throw new ImConversationError('invalid_input');
      if (prepared.pendingMedia) { if (input.mode === 'early') return null; throw new ImConversationError('invalid_input'); }
      const p = prepared;
      captureNodeStreamEvent(p.value, input.eventId);
      return (async () => {
        if (!await options.authorize(client, binding, p.value)) throw new ImConversationError('unauthorized');
        const classification = await options.classify(client, binding, p.value);
        if (classification === 'control' || p.value.telegram_command === 'bind') return null;
        if (input.mode === 'passive' || input.expectedClass === 'passive' ? classification !== 'passive' || p.type !== 'group' : classification !== 'reply') {
          if (input.mode === 'early') return null;
          throw new ImConversationError('invalid_input');
        }
        const lock = Buffer.from(p.scopeHash, 'hex');
        await client.query('SELECT pg_advisory_xact_lock($1,$2)', [lock.readInt32BE(0), lock.readInt32BE(4)]);
        const retired = () => options.retired?.(client, { ownerId: binding.ownerId, platform: binding.platform, botId: binding.botId,
          chatType: p.type, scopeHash: p.scopeHash, eventHash: p.eventHash }) ?? false;
        if (await retired()) return null;
        const key = [binding.ownerId, binding.platform, binding.botId, p.type, p.scopeHash, p.eventHash];
        if (options.retired) await client.query(`SELECT s.id FROM conversation_sessions s WHERE s.user_id=$1 AND s.id IN (
          SELECT r.session_id FROM gugu_im_inbound_receipts r WHERE r.user_id=$1 AND r.platform=$2 AND r.bot_id=$3
            AND r.chat_type=$4 AND r.scope_hash=$5 AND r.event_hash=$6) ORDER BY s.id FOR UPDATE OF s`, key);
        const existing = await client.query<ReceiptRow>(`SELECT r.fingerprint,r.session_id,r.message_id,m.conversation_seq::text,r.state,r.run_id,r.sealed_payload,
          EXISTS(SELECT 1 FROM gugu_im_inbound_batch_members bm WHERE bm.user_id=r.user_id AND bm.platform=r.platform AND bm.bot_id=r.bot_id AND bm.chat_type=r.chat_type AND bm.scope_hash=r.scope_hash AND bm.event_hash=r.event_hash) AS batched
          FROM gugu_im_inbound_receipts r JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
          JOIN conversation_messages m ON m.id=r.message_id AND m.session_id=s.id
          WHERE r.user_id=$1 AND r.platform=$2 AND r.bot_id=$3 AND r.chat_type=$4 AND r.scope_hash=$5 AND r.event_hash=$6 FOR UPDATE OF r,s`, key);
        const previous = existing.rows[0];
        if (previous && previous.fingerprint !== p.fingerprint) throw new ImConversationError('conflict');
        let sessionId: number, messageId: number, sequence: number, isNew = false;
        if (previous) {
          if (previous.batched && previous.state !== 'dispatched'
            && (input.mode === 'dispatch' || input.mode === 'passive' && previous.state !== 'passive')) throw new ImConversationError('conflict');
          sessionId = positive(previous.session_id); messageId = positive(previous.message_id); sequence = Number(previous.conversation_seq);
          if (!Number.isSafeInteger(sequence) || sequence < 1 || !['staged', 'passive', 'dispatched'].includes(previous.state)
            || previous.state === 'dispatched' && (typeof previous.run_id !== 'string' || !previous.run_id)) throw new ImConversationError('conflict');
          if (previous.state === 'passive' && input.mode === 'early')
            return { sessionId, messageId, conversationSeq: sequence, runId: null, duplicate: true, isNewSession: false, recordedPassive: true };
          if (previous.state === 'dispatched' || input.mode === 'early' || previous.state === 'passive' && input.mode === 'passive') return { sessionId, messageId, conversationSeq: sequence, runId: previous.run_id, duplicate: true, isNewSession: false };
        } else {
          const bound = p.type === 'c2c' ? await options.ownerSession?.(client, binding, p.value) ?? null : null;
          let session: { id: number } | undefined;
          if (bound !== null) {
            session = (await client.query<{ id: number }>(`SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 AND (source='web' OR source IS NULL) FOR UPDATE`, [positive(bound), binding.ownerId])).rows[0];
            if (!session) throw new ImConversationError('not_found');
          } else {
            const params = [binding.ownerId, binding.platform, binding.botId, p.chat, p.sender];
            if (input.sessionId !== undefined) session = (await client.query<{ id: number }>(`SELECT id FROM conversation_sessions WHERE ${imSessionScopeSql} AND id=$6 FOR UPDATE`, [...params, positive(input.sessionId)])).rows[0];
            if (!session) session = (await client.query<{ id: number }>(`SELECT id FROM conversation_sessions WHERE ${imSessionScopeSql} ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, params)).rows[0];
          }
          // 清理持session行锁；等到该锁后再次读取，防止早查墓碑后旧收据被级联删除。
          if (await retired()) return null;
          if (!session) {
            if (input.mode === 'early') return null;
            await options.beforeCreate?.(client, binding.ownerId);
            const ownBotId = binding.platform === 'qq' && p.type === 'group' ? optionalText(p.value.platform_bot_user_id, 128) : null
            const text = p.value.text as string
            const title = ownBotId ? (replacePlatformMentionIds(text, new Map([[ownBotId, '咕咕']])) ?? text) : text
            session = (await client.query<{ id: number }>(`INSERT INTO conversation_sessions
              (user_id,title,title_locked,summary,source,bot_id,chat_id,platform_user_id,chat_type,context_epoch,baseline_message_seq,last_message_seq,execution_state,pending_message_count,created_at,updated_at)
              VALUES($1,$2,false,'',$3,$4,$5,$6,$7,1,0,0,'idle',0,clock_timestamp(),clock_timestamp()) RETURNING id`,
            [binding.ownerId, Array.from(title).slice(0, 50).join('') || '新对话', binding.platform, binding.botId, p.chat, p.type === 'c2c' ? p.sender : null, p.type])).rows[0];
            isNew = true;
          }
          sessionId = positive(session?.id);
          let cards: readonly Record<string, unknown>[] = [];
          if (p.ids.length) {
            if (options.attachments.mode !== 'enabled') throw new ImConversationError('invalid_input');
            cards = await options.attachments.resolve(client, binding.ownerId, p.ids);
            if (cards.length !== p.ids.length || cards.some((card, index) => card.attach_id !== p.ids[index])) throw new ImConversationError('conflict');
            for (const card of cards) {
              const { qq_face, quoted, upload, ...stable } = card;
              if ([qq_face, quoted, upload].some(value => value !== undefined && typeof value !== 'boolean')) throw new ImConversationError('conflict');
              normalizePersistentArtifact(stable);
            }
          }
          const allocated = await client.query<{ last_message_seq: string }>(`UPDATE conversation_sessions SET last_message_seq=last_message_seq+1,
            updated_at=clock_timestamp(),chat_type=COALESCE($3,chat_type)
            WHERE id=$1 AND user_id=$2 RETURNING last_message_seq::text`, [sessionId, binding.ownerId, bound === null ? p.type : null]);
          sequence = Number(allocated.rows[0]?.last_message_seq);
          if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ImConversationError('conflict');
          const row = await client.query<{ id: number }>(`INSERT INTO conversation_messages
            (session_id,conversation_seq,role,content,client_message_id,files,quoted_text,platform_user_id,platform_user_name,platform_bot_user_id,chat_type,im_platform_message_id,im_reply_to_message_id,im_reply_target_sender_id,im_reply_target_is_bot,im_sender_is_bot,im_event_received_ms,im_platform_sent_ms,run_id,created_at,sent_at)
            VALUES($1,$2,'user',$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,clock_timestamp(),clock_timestamp()) RETURNING id`,
          [sessionId, sequence, p.value.text, p.eventHash, cards.length ? JSON.stringify(cards) : null, typeof p.value.quoted_text === 'string' ? p.value.quoted_text : null,
            p.sender, optionalText(p.value.platform_user_name, 200), optionalText(p.value.platform_bot_user_id, 128), p.type,
            optionalText(p.value.platform_message_id ?? (binding.platform === 'telegram' && typeof p.value.message_id === 'string' && /^[1-9]\d*$/.test(p.value.message_id) ? p.value.message_id : null), 512), optionalText(p.value.reply_to_platform_message_id, 512), optionalText(p.value.reply_target_sender_id, 128),
            typeof p.value.reply_target_is_bot === 'boolean' ? p.value.reply_target_is_bot : null, typeof p.value.sender_is_bot === 'boolean' ? p.value.sender_is_bot : null,
            /^\d+-\d+$/.test(input.eventId) ? input.eventId.split('-')[0] : null, millis(p.value.platform_sent_ms), `im-pending:${p.eventHash.slice(0, 32)}`]);
          messageId = positive(row.rows[0]?.id);
          await client.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'staged',NULL,$10::jsonb)`, [...key, p.fingerprint, sessionId, messageId, JSON.stringify(envelope.seal(binding, p.value))]);
        }
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ImConversationError('conflict');
        let runId: string | null = null;
        if (input.mode === 'dispatch' || input.mode === 'passive') {
          if (p.ids.length) {
            if (options.attachments.mode !== 'enabled') throw new ImConversationError('invalid_input');
            await options.attachments.claim(client, binding.ownerId, messageId, p.ids);
          }
          const anchor = { sessionId, messageId, conversationSeq: sequence, runId: null, duplicate: !!previous, isNewSession: isNew };
          runId = input.mode === 'dispatch' ? identifier(await input.onDispatch!(client, anchor), 128) : null;
          if (runId !== null && (await client.query(`SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND message_id<>$4 LIMIT 1`,
            [binding.ownerId, sessionId, runId, messageId])).rowCount) throw new ImConversationError('conflict');
          if (!await options.authorize(client, binding, p.value)) throw new ImConversationError('unauthorized');
          await client.query('UPDATE conversation_messages SET run_id=$3 WHERE id=$1 AND session_id=$2', [messageId, sessionId, runId]);
          if (input.mode === 'dispatch') await client.query(`UPDATE gugu_im_inbound_receipts SET state='dispatched',run_id=$7 WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND event_hash=$6`, [...key, runId]);
          else await client.query(`UPDATE gugu_im_inbound_receipts SET state='passive',run_id=NULL WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND event_hash=$6`, key);
          if (runId) await options.afterDispatch?.(client, binding, p.value,
            { ownerId: binding.ownerId, sessionId: String(sessionId), runId }, [String(messageId)]);
          else if(input.mode==='passive')await options.afterPassive?.(client,binding.ownerId,sessionId,[String(messageId)]);
        }
        return { sessionId, messageId, conversationSeq: sequence, runId, duplicate: !!previous, isNewSession: isNew };
      })();
  }
  function openSegment(binding: NodeImBotBinding, row: SegmentRow): ImConversationSegment {
    if (row.user_id !== binding.ownerId || row.platform !== binding.platform || row.bot_id !== binding.botId
      || !['started', 'completed'].includes(row.state) || !['dispatch', 'passive'].includes(row.mode)
      || !Array.isArray(row.anchors) || !row.anchors.length || row.anchors.length > 128
      || ![row.scope_hash, row.segment_key, row.batch_key].every(key => /^[a-f0-9]{64}$/.test(key))
      || row.state === 'started' && row.run_id !== null
      || row.state === 'completed' && (row.mode === 'dispatch' ? typeof row.run_id !== 'string' || !row.run_id : row.run_id !== null)) throw new ImConversationError('conflict');
    const aggregate = envelope.open(binding, row.sealed_payload), messages = aggregate._batch_messages;
    if (!Array.isArray(messages) || messages.length !== row.anchors.length || !object(aggregate._inbound_batch)) throw new ImConversationError('conflict');
    const facts = aggregate._inbound_batch;
    if (facts.batchKey !== row.batch_key || facts.segmentKey !== row.segment_key || facts.index !== row.segment_index
      || stableJson(facts.messageIds) !== stableJson(row.anchors.map(a => a.messageId))) throw new ImConversationError('conflict');
    const ids = new Set<number>();
    for (const anchor of row.anchors) {
      if (positive(anchor.sessionId) !== positive(row.session_id) || ids.has(positive(anchor.messageId))
        || !Number.isSafeInteger(anchor.conversationSeq) || anchor.conversationSeq < 1) throw new ImConversationError('conflict');
      ids.add(anchor.messageId);
    }
    return { batchKey: row.batch_key, segmentKey: row.segment_key, index: row.segment_index,
      anchors: row.anchors.map(a => ({ ...a, runId: row.run_id })), aggregate, runId: row.run_id, duplicate: row.state === 'completed' };
  }
  async function validateSegment(client: PoolClient, binding: NodeImBotBinding, row: SegmentRow) {
    const segment = openSegment(binding, row), messages = segment.aggregate._batch_messages as Payload[];
    const anchors = await client.query<{ id: number; conversation_seq: string; run_id: string | null; fingerprint: string }>(`SELECT m.id,m.conversation_seq::text,m.run_id,r.fingerprint
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
      JOIN gugu_im_inbound_batch_members bm ON bm.user_id=r.user_id AND bm.platform=r.platform AND bm.bot_id=r.bot_id AND bm.chat_type=r.chat_type AND bm.scope_hash=r.scope_hash AND bm.event_hash=r.event_hash
      WHERE s.user_id=$1 AND s.id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND bm.segment_key=$4
      ORDER BY m.id FOR UPDATE OF m,s,r`, [binding.ownerId, row.session_id, segment.anchors.map(a => a.messageId), row.segment_key]);
    if (anchors.rows.length !== segment.anchors.length) throw new ImConversationError('conflict');
    for (const [index, payload] of messages.entries()) {
      const p = normalize(binding, payload), anchor = segment.anchors[index]!, stored = anchors.rows.find(a => a.id === anchor.messageId);
      if (p.pendingMedia || p.scopeHash !== row.scope_hash || !stored || Number(stored.conversation_seq) !== anchor.conversationSeq
        || stored.fingerprint !== p.fingerprint || row.state === 'completed' && stored.run_id !== row.run_id)
        throw new ImConversationError('conflict');
      if (!await options.authorize(client, binding, p.value)) throw new ImConversationError('unauthorized');
      const attention = segment.aggregate._node_attention === undefined ? null : parseImAttentionRecord(segment.aggregate._node_attention);
      if (await options.classify(client, binding, p.value) !== (row.mode === 'passive' && !attention ? 'passive' : 'reply')) throw new ImConversationError('conflict');
    }
    return segment;
  }
  const store = {
    /** 注意力ASR只在事务外读取字节/调用Provider；这里短事务复用整段密封与锚点校验。 */
    async readValidatedStartedSegment(binding: NodeImBotBinding, input: {
      sessionId: number; scopeHash: string; eventHashes: readonly string[];
    }): Promise<{ segment: ImConversationSegment; state: 'started' | 'completed'; mode: 'dispatch' | 'passive' }> {
      if (!/^[a-f0-9]{64}$/.test(input.scopeHash) || !input.eventHashes.length || input.eventHashes.length > 128
        || input.eventHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) || new Set(input.eventHashes).size !== input.eventHashes.length)
        throw new ImConversationError('invalid_input');
      return locked(async client => {
        if (options.retired) await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',
          [binding.ownerId, positive(input.sessionId)]);
        const found = await client.query<SegmentRow>(`SELECT b.* FROM gugu_im_inbound_segments b
          JOIN conversation_sessions s ON s.id=b.session_id AND s.user_id=b.user_id
          WHERE b.user_id=$1 AND b.platform=$2 AND b.bot_id=$3 AND b.chat_type='group' AND b.scope_hash=$4 AND b.session_id=$5
            AND EXISTS(SELECT 1 FROM gugu_im_inbound_batch_members bm WHERE bm.user_id=b.user_id AND bm.platform=b.platform
              AND bm.bot_id=b.bot_id AND bm.chat_type=b.chat_type AND bm.scope_hash=b.scope_hash AND bm.segment_key=b.segment_key
              AND bm.event_hash=ANY($6::text[])) FOR SHARE OF b`,
        [normalizeOwnerId(binding.ownerId), binding.platform, binding.botId, input.scopeHash, positive(input.sessionId), input.eventHashes]);
        if (found.rows.length !== 1) throw new ImConversationError('conflict');
        const row = found.rows[0]!;
        if (row.state !== 'started' && !(row.state === 'completed' && row.mode === 'passive')) throw new ImConversationError('conflict');
        return { segment: await validateSegment(client, binding, row), state: row.state, mode: row.mode };
      });
    },
    async persist(binding: NodeImBotBinding, payload: Payload, input: ImConversationPersistInput): Promise<ImConversationAnchor | null> {
      const result = await locked(client => persistLocked(client, binding, payload, input));
      if (result) try { await options.afterCommit?.(binding.ownerId, result.sessionId); } catch { /* 已提交消息可查询恢复，通知失败不回滚。 */ }
      return result;
    },
    async persistBatch(binding: NodeImBotBinding, items: readonly ImConversationBatchItem[], input: {
      batchId?: string; mode: 'dispatch' | 'passive'; sessionId?: number;
      /** 平台/Redis查询在事务外完成；返回值由本事务密封保存，不接受入站声明。 */
      beforeDispatch?(segment: ImConversationSegment): Promise<ImAttentionRecord | null>;
      validateAttention?(client: PoolClient, record: ImAttentionRecord): Promise<boolean>;
      onDispatch?(client: PoolClient, segment: ImConversationSegment): Promise<string>;
    }): Promise<{ segments: ImConversationSegment[] }> {
      if (!items.length || items.length > 128 || !['dispatch', 'passive'].includes(input.mode)
        || input.mode === 'dispatch' && !input.onDispatch) throw new ImConversationError('invalid_input');
      if (input.batchId !== undefined) identifier(input.batchId, 8192);
      const prepared = items.map(item => {
        try {
        identifier(item.eventId, 8192);
        const p = normalize(binding, item.payload);
        if (p.pendingMedia) throw new ImConversationError('invalid_input');
        captureNodeStreamEvent(p.value, item.eventId);
        return { eventId: item.eventId, p, message: { platform: binding.platform, botId: binding.botId,
          chatType: p.type, senderId: p.sender, chatId: p.chat ?? '',
          platformSentMs: typeof p.value.platform_sent_ms === 'number' ? p.value.platform_sent_ms : undefined,
          botMentioned: p.value.bot_mentioned === true, mentionsOtherBot: p.value.mentions_other_bot === true,
          pendingAskResume: p.value._pending_ask_resume === true } };
        } catch { throw new ImConversationError('invalid_input'); }
      });
      let partition: ReturnType<typeof partitionImInboundBatch<(typeof prepared)[number]['message']>>;
      try { partition = partitionImInboundBatch(prepared); } catch { throw new ImConversationError('invalid_input'); }
      const byEvent = new Map(prepared.map(p => [p.eventId, p]));
      if (byEvent.size !== prepared.length || new Set(prepared.map(p => p.p.eventHash)).size !== prepared.length) throw new ImConversationError('invalid_input');
      const ordered = partition.flat().map(item => byEvent.get(item.eventId)!), first = ordered[0]!.p;
      const prefix = [binding.ownerId, binding.platform, binding.botId, first.type, first.scopeHash];
      const batchKey = digest(['batch', ...prefix, input.batchId ?? null, ordered.map(item => item.p.eventHash)]);
      const staged = await locked(async client => {
        const lock = Buffer.from(first.scopeHash, 'hex');
        await client.query('SELECT pg_advisory_xact_lock($1,$2)', [lock.readInt32BE(0), lock.readInt32BE(4)]);
        for (const item of ordered) if (!await options.authorize(client, binding, item.p.value)) throw new ImConversationError('unauthorized');
        if (options.retired) await client.query(`SELECT s.id FROM conversation_sessions s WHERE s.user_id=$1 AND s.id IN (
          SELECT r.session_id FROM gugu_im_inbound_receipts r WHERE r.user_id=$1 AND r.platform=$2 AND r.bot_id=$3
            AND r.chat_type=$4 AND r.scope_hash=$5 AND r.event_hash=ANY($6::text[])) ORDER BY s.id FOR UPDATE OF s`,
        [...prefix, ordered.map(item => item.p.eventHash)]);
        const existing = await client.query<SegmentRow & { event_hash: string }>(`SELECT b.*,bm.event_hash FROM gugu_im_inbound_batch_members bm
          JOIN gugu_im_inbound_segments b USING(user_id,platform,bot_id,chat_type,scope_hash,segment_key)
          WHERE bm.user_id=$1 AND bm.platform=$2 AND bm.bot_id=$3 AND bm.chat_type=$4 AND bm.scope_hash=$5 AND bm.event_hash=ANY($6::text[]) FOR UPDATE OF b`,
        [...prefix, ordered.map(item => item.p.eventHash)]);
        const membership = new Map(existing.rows.map(row => [row.event_hash, row])), plans: string[] = [], sessionIds = new Set<number>();
        const append = (value: string) => { if (!plans.includes(value)) plans.push(value); };
        async function stage(chunk: typeof prepared, index: number) {
          if (!chunk.length) return;
          const segmentKey = digest(['segment', ...prefix, chunk.map(item => item.p.eventHash)]), anchors: ImConversationAnchor[] = [];
          for (const item of chunk) {
            const anchor = await persistLocked(client, binding, item.p.value, { eventId: item.eventId, mode: 'stage',
              expectedClass: input.mode === 'passive' ? 'passive' : 'reply', sessionId: anchors[0]?.sessionId ?? input.sessionId });
            if (!anchor || anchor.recordedPassive || anchor.runId !== null || anchors.length && anchor.sessionId !== anchors[0]!.sessionId) throw new ImConversationError('conflict');
            anchors.push(anchor);
          }
          // 平台重新入队可能获得新Stream ID；正文/回复凭证/首次来源仍以原收据为准。
          const originals = await client.query<{ message_id: number; sealed_payload: Payload }>(`SELECT message_id,sealed_payload FROM gugu_im_inbound_receipts
            WHERE user_id=$1 AND session_id=$2 AND message_id=ANY($3::integer[])`, [binding.ownerId, anchors[0]!.sessionId, anchors.map(a => a.messageId)]);
          if (originals.rows.length !== anchors.length) throw new ImConversationError('conflict');
          const source = chunk.map((item, i) => {
            const row = originals.rows.find(r => r.message_id === anchors[i]!.messageId);
            if (!row) throw new ImConversationError('conflict');
            const value = envelope.open(binding, row.sealed_payload), original = normalize(binding, value);
            if (original.pendingMedia || original.fingerprint !== item.p.fingerprint || original.eventHash !== item.p.eventHash) throw new ImConversationError('conflict');
            return { eventId: typeof value._node_stream_event_id === 'string' ? value._node_stream_event_id : item.eventId,
              payload: value, anchor: anchors[i]! };
          });
          const aggregate = aggregateImInboundPayloads(source);
          sessionIds.add(anchors[0]!.sessionId);
          aggregate._inbound_batch = { batchKey, segmentKey, index, eventIds: source.map(p => p.eventId), messageIds: anchors.map(a => a.messageId) };
          if (input.beforeDispatch) aggregate._node_attention_required = true;
          await client.query(`INSERT INTO gugu_im_inbound_segments(user_id,platform,bot_id,chat_type,scope_hash,segment_key,batch_key,segment_index,session_id,state,mode,run_id,anchors,sealed_payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'started',$10,NULL,$11::jsonb,$12::jsonb)`,
          [...prefix, segmentKey, batchKey, index, anchors[0]!.sessionId, input.mode, JSON.stringify(anchors), JSON.stringify(envelope.seal(binding, aggregate))]);
          for (const [ordinal, item] of chunk.entries()) await client.query(`INSERT INTO gugu_im_inbound_batch_members(user_id,platform,bot_id,chat_type,scope_hash,event_hash,segment_key,ordinal)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [...prefix, item.p.eventHash, segmentKey, ordinal]);
          append(segmentKey);
        }
        for (const [index, part] of partition.entries()) {
          let chunk: typeof prepared = [];
          for (const entry of part) {
            const item = byEvent.get(entry.eventId)!, prior = membership.get(item.p.eventHash);
            if (!prior) { chunk.push(item); continue; }
            await stage(chunk, index); chunk = [];
            if (prior.mode !== input.mode && !(input.mode === 'dispatch' && prior.mode === 'passive'
              && prior.state === 'completed' && openSegment(binding, prior).aggregate._node_attention_required === true
              && parseImAttentionRecord(openSegment(binding, prior).aggregate._node_attention).disposition !== 'run')) throw new ImConversationError('conflict');
            const original = openSegment(binding, prior), messages = original.aggregate._batch_messages as Payload[];
            sessionIds.add(positive(prior.session_id));
            if (!messages.some(payload => { const p = normalize(binding, payload); return !p.pendingMedia && p.eventHash === item.p.eventHash && p.fingerprint === item.p.fingerprint; })) throw new ImConversationError('conflict');
            append(prior.segment_key);
          }
          await stage(chunk, index);
        }
        return { keys: plans, sessionIds: [...sessionIds] };
      });
      for (const session of staged.sessionIds) try { await options.afterCommit?.(binding.ownerId, session); } catch { /* started锚点已持久化，不受通知失败影响。 */ }
      const results: ImConversationSegment[] = [];
      for (const segmentKey of staged.keys) {
        // 不在持有会话行锁时调用Redis/注意力读取；事务内仍复核配置、权限和段状态。
        let decision: ImAttentionRecord | null = null;
        let evaluated = false;
        if (input.mode === 'dispatch' && input.beforeDispatch) {
          const read = await options.pool.query<SegmentRow>(`SELECT * FROM gugu_im_inbound_segments
            WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND segment_key=$6`, [...prefix, segmentKey]);
          if (read.rows.length !== 1) throw new ImConversationError('conflict');
          if (read.rows[0]!.state === 'started') {
            const value = await input.beforeDispatch(openSegment(binding, read.rows[0]!));
            if (value !== null) decision = parseImAttentionRecord(value);
            evaluated = true;
          }
        }
        const result = await locked(async client => {
          const lock = Buffer.from(first.scopeHash, 'hex');
          await client.query('SELECT pg_advisory_xact_lock($1,$2)', [lock.readInt32BE(0), lock.readInt32BE(4)]);
          if (options.retired) await client.query(`SELECT s.id FROM conversation_sessions s JOIN gugu_im_inbound_segments b
            ON b.session_id=s.id AND b.user_id=s.user_id WHERE b.user_id=$1 AND b.platform=$2 AND b.bot_id=$3
              AND b.chat_type=$4 AND b.scope_hash=$5 AND b.segment_key=$6 FOR UPDATE OF s`, [...prefix, segmentKey]);
          const found = await client.query<SegmentRow>(`SELECT b.* FROM gugu_im_inbound_segments b
            JOIN conversation_sessions s ON s.id=b.session_id AND s.user_id=b.user_id
            WHERE b.user_id=$1 AND b.platform=$2 AND b.bot_id=$3 AND b.chat_type=$4 AND b.scope_hash=$5 AND b.segment_key=$6 FOR UPDATE OF b,s`, [...prefix, segmentKey]);
          if (found.rows.length !== 1) throw new ImConversationError('conflict');
          const row = found.rows[0]!, segment = await validateSegment(client, binding, row);
          if (row.state === 'completed') return { ...segment, duplicate: true };
          if (segment.aggregate._node_attention_required === true && !evaluated) throw new ImConversationError('conflict');
          if (decision) {
            if (!input.validateAttention || !await input.validateAttention(client, decision)) throw new ImConversationError('conflict');
            segment.aggregate._node_attention = decision;
            if (decision.disposition !== 'run') row.mode = 'passive';
          }
          // 作用域中更早的 started 段必须先登记Run，不能让另一批次抢先入队。
          if ((await client.query(`SELECT 1 FROM gugu_im_inbound_segments WHERE user_id=$1 AND platform=$2 AND bot_id=$3
            AND chat_type=$4 AND scope_hash=$5 AND state='started' AND sequence<$6 LIMIT 1`, [...prefix, row.sequence])).rowCount)
            throw new ImConversationError('conflict');
          const messages = segment.aggregate._batch_messages as Payload[];
          for (const [index, payload] of messages.entries()) {
            const p = normalize(binding, payload); if (p.pendingMedia) throw new ImConversationError('conflict');
            if (p.ids.length) {
              if (options.attachments.mode !== 'enabled') throw new ImConversationError('invalid_input');
              await options.attachments.claim(client, binding.ownerId, segment.anchors[index]!.messageId, p.ids);
            }
          }
          const runId = row.mode === 'dispatch' ? identifier(await input.onDispatch!(client, segment), 128) : null;
          if (runId !== null && (await client.query(`SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND message_id<>ALL($4::integer[]) LIMIT 1`,
            [binding.ownerId, row.session_id, runId, segment.anchors.map(a => a.messageId)])).rowCount) throw new ImConversationError('conflict');
          for (const payload of messages) if (!await options.authorize(client, binding, payload)) throw new ImConversationError('unauthorized');
          const updated = await client.query(`UPDATE conversation_messages m SET run_id=$4 WHERE m.session_id=$2 AND m.id=ANY($3::integer[])
            AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=m.session_id AND s.user_id=$1)`, [binding.ownerId, row.session_id, segment.anchors.map(a => a.messageId), runId]);
          if (updated.rowCount !== segment.anchors.length) throw new ImConversationError('conflict');
          const receipts = await client.query(`UPDATE gugu_im_inbound_receipts r SET state=$7,run_id=$8 FROM gugu_im_inbound_batch_members bm
            WHERE bm.user_id=$1 AND bm.platform=$2 AND bm.bot_id=$3 AND bm.chat_type=$4 AND bm.scope_hash=$5 AND bm.segment_key=$6
              AND r.user_id=bm.user_id AND r.platform=bm.platform AND r.bot_id=bm.bot_id AND r.chat_type=bm.chat_type AND r.scope_hash=bm.scope_hash AND r.event_hash=bm.event_hash`,
          [...prefix, segmentKey, row.mode === 'dispatch' ? 'dispatched' : 'passive', runId]);
          if (receipts.rowCount !== segment.anchors.length) throw new ImConversationError('conflict');
          await client.query(`UPDATE gugu_im_inbound_segments SET state='completed',run_id=$7,mode=$8,sealed_payload=$9::jsonb
            WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND segment_key=$6`,
            [...prefix, segmentKey, runId, row.mode, JSON.stringify(envelope.seal(binding, segment.aggregate))]);
          if (runId) await options.afterDispatch?.(client, binding, segment.aggregate,
            { ownerId: binding.ownerId, sessionId: String(row.session_id), runId }, segment.anchors.map(anchor => String(anchor.messageId)));
          else if(row.mode==='passive')await options.afterPassive?.(client,binding.ownerId,Number(row.session_id),segment.anchors.map(anchor=>String(anchor.messageId)));
          return { ...segment, runId, duplicate: false, anchors: segment.anchors.map(a => ({ ...a, runId })) };
        });
        results.push(result);
        try { await options.afterCommit?.(binding.ownerId, result.anchors[0]!.sessionId); } catch { /* 已提交的段由持久收据恢复。 */ }
      }
      return { segments: results };
    },
    /** 借用调用方事务，成功历史登记反思时不得另借连接等待自身会话锁。 */
    async readRouteLocked(client: PoolClient, identity: RunIdentity): Promise<{ binding: NodeImBotBinding; payload: Payload }> {
        // 已完成材料只在同Session围栏下读；调用方可能已持S，不能反向等待入站先持的scope锁。
        const owned = await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',
          [normalizeOwnerId(identity.ownerId), positive(identity.sessionId)]);
        if (owned.rowCount !== 1) throw new ImConversationError('not_found');
        const batches = await client.query<SegmentRow>(`SELECT b.* FROM gugu_im_inbound_segments b
          JOIN conversation_sessions s ON s.id=b.session_id AND s.user_id=b.user_id
          JOIN user_bots bot ON bot.id::text=b.bot_id AND bot.user_id=b.user_id AND bot.platform=b.platform AND bot.enabled IS TRUE
          WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.state='completed'`,
        [normalizeOwnerId(identity.ownerId), positive(identity.sessionId), identifier(identity.runId, 128)]);
        if (batches.rows.length > 1) throw new ImConversationError('conflict');
        if (batches.rows[0]) {
          const row = batches.rows[0], binding = { platform: row.platform, botId: row.bot_id, ownerId: normalizeOwnerId(identity.ownerId) };
          openSegment(binding, row);
          const segment = await validateSegment(client, binding, row);
          return { binding, payload: segment.aggregate };
        }
        const rows = await client.query<{ platform: NodeImBotBinding['platform']; bot_id: string; sealed_payload: Payload }>(`SELECT r.platform,r.bot_id,r.sealed_payload FROM gugu_im_inbound_receipts r
          JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
          JOIN user_bots b ON b.id::text=r.bot_id AND b.user_id=r.user_id AND b.platform=r.platform AND b.enabled IS TRUE
          WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.state='dispatched'`, [normalizeOwnerId(identity.ownerId), positive(identity.sessionId), identifier(identity.runId, 128)]);
        if (rows.rows.length !== 1) throw new ImConversationError('not_found');
        const row = rows.rows[0]!; const binding = { platform: row.platform, botId: row.bot_id, ownerId: normalizeOwnerId(identity.ownerId) };
        const payload = envelope.open(binding, row.sealed_payload);
        if (!await options.authorize(client, binding, payload)) throw new ImConversationError('unauthorized');
        return { binding, payload };
    },
    async readRoute(identity: RunIdentity): Promise<{ binding: NodeImBotBinding; payload: Payload }> {
      return locked(client => store.readRouteLocked(client, identity));
    },
  };
  return store;
}
