import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { RunIdentity } from '../models.js'

export function createFirstTurnTitleWriter(db: Kysely<Database>, backend: 'sqlite' | 'postgres') {
  return async (input: {
    identity: RunIdentity
    anchorMessageId: string
    reply: string
    locale?: string | null
    complete(prompt: string): Promise<string>
  }): Promise<boolean> => {
    const { identity, anchorMessageId, reply } = input
    if (!reply.trim()) return false
    const ownerId = dataContext(identity.ownerId).ownerId
    const owner = backend === 'sqlite' ? ownerId.replaceAll('-', '') : ownerId
    const session = Number(identity.sessionId)
    const eligible = sql`s.id=${session} AND s.user_id=${owner} AND s.source='web' AND NOT s.title_locked
      AND m.id=${Number(anchorMessageId)} AND m.session_id=s.id AND m.role='user'
      AND NOT EXISTS (SELECT 1 FROM conversation_messages older WHERE older.session_id=s.id
        AND older.role='user' AND older.id<m.id)`
    const { rows: [first] } = await sql<{ content: string; title: string; context_epoch: number }>`
      SELECT m.content,s.title,s.context_epoch FROM conversation_sessions s,conversation_messages m WHERE ${eligible}`.execute(db)
    if (!first) return false

    const languages: Readonly<Record<string, string>> = { 'zh-CN': '简体中文', 'ja-JP': '日本語', 'en-US': 'English' }
    const language = languages[input.locale ?? '']
    const prompt = [
      '根据下面的对话生成一个简短的会话标题。只输出标题，不加引号、标点或解释。',
      language ? `标题使用${language}。` : '标题使用用户交流的语言。',
      `用户：${[...first.content].slice(0, 150).join('')}`,
      `咕咕：${[...reply].slice(0, 300).join('')}`,
    ].join('\n')
    const generated = (await input.complete(prompt)).split(/\r?\n/u)[0]!.trim().replace(/^["'「『“]+|["'」』”]+$/gu, '').trim()
    const title = [...generated].slice(0, 30).join('')
    if (!title || title === first.title) return false

    const { rows } = await sql`UPDATE conversation_sessions AS s SET title=${title}
      WHERE s.title=${first.title} AND s.context_epoch=${first.context_epoch}
        AND EXISTS (SELECT 1 FROM conversation_messages m WHERE ${eligible})
      RETURNING id`.execute(db)
    return rows.length === 1
  }
}
