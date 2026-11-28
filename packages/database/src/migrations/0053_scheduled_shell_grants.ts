import type { LogicalMigration } from './plan.js'

// 保留已应用的迁移定义，供数据库启动时核验历史记录。
export const scheduledShellGrants = {
  id: '0053_scheduled_shell_grants',
  targets: ['postgres', 'sqlite'],
  prerequisites: ['scheduled_tasks'],
  tables: ['scheduled_shell_grants'],
  build: db => [db.schema.createTable('scheduled_shell_grants')
    .addColumn('owner_key', 'text', col => col.notNull())
    .addColumn('task_id', 'integer', col => col.notNull().references('scheduled_tasks.id').onDelete('cascade'))
    .addColumn('revision', 'text', col => col.notNull())
    .addColumn('fingerprint', 'text', col => col.notNull())
    .addColumn('expires_at', 'varchar(32)', col => col.notNull())
    .addPrimaryKeyConstraint('pk_scheduled_shell_grants', ['owner_key', 'task_id', 'revision', 'fingerprint'])],
} as const satisfies LogicalMigration
