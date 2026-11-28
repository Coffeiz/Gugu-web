import type { LogicalMigration } from './plan.js'

export const imGroupDisabledNotices = {
  id: '0054_im_group_disabled_notices',
  targets: ['postgres'],
  prerequisites: ['user_bots'],
  tables: ['im_group_disabled_notices'],
  build: db => [
    db.schema.alterTable('user_bots').addColumn('group_disabled_epoch', 'text', col => col.notNull().defaultTo('initial')),
    db.schema.createTable('im_group_disabled_notices')
      .addColumn('bot_id', 'integer', col => col.notNull().references('user_bots.id').onDelete('cascade'))
      .addColumn('group_id', 'text', col => col.notNull())
      .addColumn('epoch', 'text', col => col.notNull())
      .addPrimaryKeyConstraint('pk_im_group_disabled_notices', ['bot_id', 'group_id', 'epoch']),
  ],
} as const satisfies LogicalMigration
