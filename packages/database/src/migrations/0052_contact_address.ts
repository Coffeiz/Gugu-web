import type { LogicalMigration } from './plan.js'

export const contactAddress = {
  id: '0052_contact_address',
  targets: ['postgres', 'sqlite'],
  prerequisites: ['clients'],
  tables: ['clients'],
  createdObjects: [],
  build: db => [db.schema.alterTable('clients').addColumn('address', 'varchar(500)')],
} as const satisfies LogicalMigration
