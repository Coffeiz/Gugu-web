import type { Transaction } from 'kysely'

export type ScheduleDatabaseBackend = 'sqlite' | 'postgres'

/** 调用方提供身份校验和时间编码，数据库包保留查询与事务边界。 */
export interface ScheduleDatabaseCodec {
  writeTime(value: number): string
  readTime(value: unknown): string
  readOwner(value: string): string
  writeOwner(value: string): string
}

export type ScheduleTaskDeleted<DB> = (tx: Transaction<DB>, owner: string, taskId: number) => Promise<void>

export interface StoppedScheduleRow {
  id: number
  name: string
  filesystem_authorization_grant_id: number | null
}
