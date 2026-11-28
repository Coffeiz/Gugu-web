import { DatabaseError } from './error.js'

export type MigrationAction = 'check' | 'apply'
export type MigrationStatus = 'pending' | 'applied' | 'unchanged'

export function parseMigrationAction(args: readonly string[]): MigrationAction {
  const [action] = args
  if (args.length !== 1 || (action !== 'check' && action !== 'apply'))
    throw new DatabaseError('invalid_request', '数据库迁移命令应为 migrate check 或 migrate apply')
  return action
}

export function reportMigration(status: MigrationStatus): void {
  process.stdout.write(status + '\n')
  if (status === 'pending') process.exitCode = 2
}
