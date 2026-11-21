import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import { desktopKeyFile } from '../../shared/desktop-key-file.js'

/** 仅由持有本机数据库的可信进程读取，避免把运行密钥经 IPC 或 argv 传输。 */
export async function loadSqliteAgentRunSecret(db: Kysely<Database>, databasePath: string): Promise<string> {
  const file = desktopKeyFile(databasePath + '.agent-run-key', '本机 Agent 运行密钥无效')
  const key = await file.readOrCreate(async () => {
    const { rows } = await sql`SELECT 1 FROM agent_run_checkpoints LIMIT 1`.execute(db)
    if (rows.length) {
      // 并发初始化可能已经发布密钥并写入了第一条记录。
      try { await file.read() } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        throw new Error('本机 Agent 运行密钥缺失')
      }
    }
  })
  return key.toString('base64')
}
