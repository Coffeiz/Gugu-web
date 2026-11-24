import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql, type Transaction } from 'kysely'
import { CoreError } from '../contracts/index.js'
import { databaseTime } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { allocateDesktopSkillSequence } from '../runtime/desktop-resources.js'
import type { PortableRecord } from './desktop-preflight.js'

const optionalText = z.string().nullish().transform(value => value ?? null)
const title = z.string().min(1).max(300)
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).nullish().transform(value => value ?? null)
const jsonObject = z.record(z.string(), z.unknown()).nullish().transform(value => JSON.stringify(value ?? {}))
const schemas = {
  calendar_event: z.object({ title, date: z.iso.date(), time, end_time: time,
    type: z.string().min(1).max(50), client: optionalText, description: optionalText }),
  mind_map: z.object({ title, data: jsonObject }),
  mind_node: z.object({
    kind: z.enum(['note', 'canvas_note', 'ref']), title: optionalText, content_md: z.string(), content_plain: z.string(),
    color: optionalText, origin: z.enum(['user', 'gugu']), captured_at: z.string().nullish(),
  }),
  mind_canvas_item: z.object({
    x: z.number(), y: z.number(), w: z.number().nullish(), h: z.number().nullish(),
    z: z.number().int(), collapsed: z.boolean(), data: jsonObject,
  }),
  mind_relation: z.object({
    rel_type: z.string().min(1).max(20), edge_key: z.string().max(32),
    origin: z.string().min(1).max(10), status: z.string().min(1).max(10), note: optionalText,
  }),
}

export async function restoreDesktopRelatedRecord(
  tx: Transaction<Database>, owner: string, record: PortableRecord, created: string,
  lookup: (type: PortableRecord['type'], portableId: string) => Promise<number | null>,
) {
  const fields = record.fields
  const updated = record.updated_at ? databaseTime(record.updated_at, 'sqlite') : created
  const deleted = record.deleted_at ? databaseTime(record.deleted_at, 'sqlite') : null
  const relations = new Map((record.relations ?? []).map(relation => [relation.relation_type, relation]))
  if (relations.size !== (record.relations?.length ?? 0)) throw new CoreError('invalid_request', '归档包含重复关系')

  async function ref(name: string, type: PortableRecord['type'], required: true): Promise<number>
  async function ref(name: string, type: PortableRecord['type'], required?: false): Promise<number | null>
  async function ref(name: string, type: PortableRecord['type'], required = false) {
    const relation = relations.get(name)
    if (!relation && !required) return null
    if (!relation || relation.target_type !== type)
      throw new CoreError('invalid_request', '归档关系类型无效')
    relations.delete(name)
    const id = await lookup(type, relation.target_portable_id)
    if (id === null) throw new CoreError('invalid_request', '归档缺少关联记录，请导入包含关联数据的归档')
    return id
  }

  const base = { user_id: owner, created_at: created, updated_at: updated, deleted_at: deleted }
  let id: number
  switch (record.type) {
    case 'scheduled_task': {
      const task = z.object({ name: z.string().min(1).max(100), payload: z.string(), cron: z.string().max(60),
        schedule_kind: z.enum(['cron', 'interval', 'once']).nullish(), interval_minutes: z.number().int().positive().nullish(),
        start_at: z.string().nullish(), end_at: z.string().nullish() }).parse(fields)
      relations.delete('workspace')
      const event_id = await ref('event', 'calendar_event')
      id = (await sql<{ id: number }>`INSERT INTO scheduled_tasks
        (user_id,event_id,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,channels,enabled,execution_mode,created_at,updated_at)
        VALUES(${owner},${event_id},${task.name},${task.payload},${task.cron},${task.schedule_kind ?? 'cron'},
          ${task.interval_minutes ?? null},${task.start_at ? databaseTime(task.start_at, 'sqlite') : null},
          ${task.end_at ? databaseTime(task.end_at, 'sqlite') : null},'web',0,${event_id === null ? 'instruction' : 'reminder'},${created},${updated})
        RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'pending_queue': {
      const { items } = z.object({ items: z.array(z.object({ key: z.number().int().positive(), text: z.string().max(200_000) })).max(200) }).parse(fields)
      const session_id = await ref('session', 'conversation')
      const queueId = session_id === null
        ? 'import-' + createHash('sha256').update(record.portable_id).digest('hex').slice(0, 32)
        : 'session-' + session_id
      const body = JSON.stringify(items.map(item => ({ ...item, attachments: [], references: [] })))
      id = (await sql<{ id: number }>`INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at)
        VALUES(${owner},${queueId},${session_id},${body},${updated}) RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'skill': {
      const skill = z.object({ name: z.string().min(1).max(120), description_short: z.string().max(100),
        description_long: z.string().max(500).nullish(), category: z.string().max(40), body: z.string().min(1).max(20000),
        related_tools: z.array(z.string().max(120)).max(32).nullish() }).parse(fields)
      const sequence = await allocateDesktopSkillSequence<Database>(tx)
      if (!Number.isSafeInteger(sequence) || sequence < 2) throw new CoreError('storage_error', '无法分配技能编号')
      const skillId = 'U' + (sequence - 1)
      const digest = createHash('sha256').update(skill.body).digest('hex')
      id = (await sql<{ id: number }>`INSERT INTO user_skills
        (owner_id,skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at)
        VALUES(${owner},${skillId},${skill.name},${skill.description_short},${skill.description_long ?? null},
          ${skill.category},${skill.body},${JSON.stringify(skill.related_tools ?? [])},'user','user',0,${digest},${created},${updated})
        RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'feedback': {
      const feedback = z.object({ category: z.string().min(1).max(32), content: z.string() }).parse(fields)
      id = (await sql<{ id: number }>`INSERT INTO feedbacks(user_id,username,category,content,created_at)
        VALUES(${owner},'本地用户',${feedback.category},${feedback.content},${created}) RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'conversation': {
      const session = z.object({ title: z.string(), title_locked: z.boolean().optional(), summary: z.string().nullish() }).parse(fields)
      // 历史 IM 消息以普通会话恢复。归档没有可信的 Bot 和收件人绑定。
      relations.delete('workspace')
      id = (await sql<{ id: number }>`INSERT INTO conversation_sessions
        (user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
        VALUES(${owner},${session.title},${Number(session.title_locked ?? false)},${session.summary ?? ''},'web',0,${created},${updated})
        RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'conversation_batch': {
      const batch = z.object({ version: z.union([z.string(), z.number()]), round_id: z.string().nullish() }).parse(fields)
      const session_id = await ref('session', 'conversation', true)
      const digest = createHash('sha256').update(JSON.stringify([record.portable_id, session_id])).digest('hex')
      id = (await sql<{ id: number }>`INSERT INTO conversation_batches(session_id,version,round_id,digest,created_at)
        VALUES(${session_id},${String(batch.version)},${batch.round_id ?? null},${digest},${created}) RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'message': {
      const message = z.object({ role: z.string().min(1).max(40), content: z.string().nullish(),
        quoted_text: optionalText, sent_at: z.string().nullish() }).parse(fields)
      const session_id = await ref('session', 'conversation', true)
      const canonical_batch_id = await ref('batch', 'conversation_batch')
      if (canonical_batch_id !== null && !(await sql`SELECT 1 FROM conversation_batches
        WHERE id=${canonical_batch_id} AND session_id=${session_id}`.execute(tx)).rows.length)
        throw new CoreError('invalid_request', '归档消息和批次不在同一会话')
      const session = (await sql<{ last_message_seq: number }>`UPDATE conversation_sessions
        SET last_message_seq=last_message_seq+1 WHERE id=${session_id} AND user_id=${owner}
        RETURNING last_message_seq`.execute(tx)).rows[0]
      if (!session) throw new CoreError('invalid_request', '归档消息关联的会话不存在')
      const sentAt = message.sent_at ? databaseTime(message.sent_at, 'sqlite') : null
      id = (await sql<{ id: number }>`INSERT INTO conversation_messages
        (session_id,canonical_batch_id,conversation_seq,role,content,quoted_text,sent_at,created_at)
        VALUES(${session_id},${canonical_batch_id},${session.last_message_seq},${message.role},${message.content ?? ''},
          ${message.quoted_text},${sentAt},${created}) RETURNING id`.execute(tx)).rows[0]!.id
      break
    }
    case 'calendar_event': {
      const { client, ...event } = schemas.calendar_event.parse(fields)
      const project_id = await ref('project', 'project')
      const row = await tx.insertInto('calendar_events').values({
        ...event, user_id: owner, project_id, contact_name: client, version: 1, created_at: created, deleted_at: deleted,
      }).returning('id').executeTakeFirstOrThrow()
      id = row.id
      break
    }
    case 'mind_map': {
      const { title, data } = schemas.mind_map.parse(fields)
      const project_id = await ref('project', 'project')
      id = (await tx.insertInto('mind_maps').values({ ...base, title, project_id, data_json: data })
        .returning('id').executeTakeFirstOrThrow()).id
      break
    }
    case 'mind_node': {
      const { kind, captured_at, ...note } = schemas.mind_node.parse(fields)
      const target = relations.get('referenced_object')
      let ref_type = null
      let ref_id = null
      if (kind === 'ref' && target) {
        const supported = { project: 'project', calendar_event: 'event', mind_map: 'canvas' } as const
        const type = target.target_type as keyof typeof supported
        if (Object.hasOwn(supported, type)) {
          ref_type = supported[type]
          ref_id = await ref('referenced_object', type, true)
        } else if (target.target_type === 'event' || target.target_type === 'canvas') {
          const category = target.target_type === 'event' ? 'calendar_event' : 'mind_map'
          ref_type = target.target_type
          ref_id = await lookup(category, target.target_portable_id)
          if (ref_id === null) throw new CoreError('invalid_request', '归档缺少关联记录')
          relations.delete('referenced_object')
        } else if (['file', 'folder', 'workspace', 'workspace_directory'].includes(target.target_type)) {
          relations.delete('referenced_object')
        } else {
          throw new CoreError('invalid_request', '桌面暂不支持此笔记引用')
        }
      }
      id = (await tx.insertInto('mind_nodes').values({
        ...base, ...note, kind: kind === 'ref' && ref_id === null ? 'note' : kind, ref_type, ref_id,
        captured_at: captured_at ? databaseTime(captured_at, 'sqlite') : created, version: 1,
      }).returning('id').executeTakeFirstOrThrow()).id
      break
    }
    case 'mind_canvas_item': {
      const { data, collapsed, ...position } = schemas.mind_canvas_item.parse(fields)
      const canvas_id = await ref('canvas', 'mind_map', true)
      const node_id = await ref('node', 'mind_node', true)
      id = (await tx.insertInto('mind_canvas_items').values({
        ...base, ...position, canvas_id, node_id, data_json: data, collapsed: Number(collapsed),
      }).returning('id').executeTakeFirstOrThrow()).id
      break
    }
    case 'mind_relation': {
      const edge = schemas.mind_relation.parse(fields)
      const canvas_id = await ref('canvas', 'mind_map')
      const src_node_id = await ref('source', 'mind_node', true)
      const dst_node_id = await ref('target', 'mind_node', true)
      id = (await tx.insertInto('mind_relations').values({ ...base, ...edge, canvas_id, src_node_id, dst_node_id })
        .returning('id').executeTakeFirstOrThrow()).id
      break
    }
    default:
      throw new CoreError('invalid_request', '桌面暂不支持此归档记录')
  }
  if (relations.size) throw new CoreError('invalid_request', '归档包含不支持的关系')
  return id
}
