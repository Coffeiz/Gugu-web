import { CompiledQuery } from 'kysely'
import type { LogicalMigration } from './plan.js'

/** 迁移里直接执行裸 SQL：kysely 的查询构建器表达不了这类重建语句。 */
const raw = (statement: string) => ({ compile: () => CompiledQuery.raw(statement) })

/**
 * 旧版桌面库里的 desktop_im_reflection_jobs 多出一列历史遗留的 assistant_text（NOT NULL 且无默认值），
 * 而当前代码的入队语句从不写这一列，于是群聊反思任务入队必然触发 NOT NULL 约束失败：
 * 每次群聊运行的收尾钩子都失败，群记忆反思再也排不上队（该表在旧库里长期为空）。
 *
 * 这里把表重建成与基线一致的结构：只复制代码真正使用的列，不引用历史列，
 * 因此对「有该列」和「无该列」两种旧库都成立。
 * 重建期间会先删旧表：外键开启时 SQLite 的删表等价于先删父表行，
 * 子表 desktop_im_reflection_plans 里尚未完成的临时计划会随之清空（可重新生成，不影响已入队任务）。
 */
export const desktopImReflectionJobColumns = {
  id: '0056_desktop_im_reflection_job_columns',
  targets: ['sqlite'],
  prerequisites: ['desktop_im_reflection_jobs'],
  tables: ['desktop_im_reflection_jobs'],
  indexes: ['desktop_im_reflection_jobs_pending'],
  createdObjects: ['desktop_im_reflection_jobs_v2'],
  build: () => [
    raw(`CREATE TABLE desktop_im_reflection_jobs_v2 (
      owner_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('owner','group','platform-user')),
      scope_id TEXT NOT NULL,
      model_identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY(owner_id,session_id,run_id,scope_type,scope_id),
      FOREIGN KEY(owner_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    )`),
    raw(`INSERT INTO desktop_im_reflection_jobs_v2
      (owner_id,session_id,run_id,user_message_id,platform,connection_id,event_key,scope_type,scope_id,model_identity,status,attempts,claimed_at_ms,created_at_ms,last_error)
      SELECT owner_id,session_id,run_id,user_message_id,platform,connection_id,event_key,scope_type,scope_id,model_identity,status,attempts,claimed_at_ms,created_at_ms,last_error
      FROM desktop_im_reflection_jobs`),
    raw('DROP TABLE desktop_im_reflection_jobs'),
    raw('ALTER TABLE desktop_im_reflection_jobs_v2 RENAME TO desktop_im_reflection_jobs'),
    raw('CREATE INDEX desktop_im_reflection_jobs_pending ON desktop_im_reflection_jobs(owner_id, session_id, status, created_at_ms)'),
  ],
} as const satisfies LogicalMigration
