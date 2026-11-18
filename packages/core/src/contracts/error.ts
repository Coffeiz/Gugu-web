export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'storage_error'
  | 'schema_upgrade_required'
  | 'closed'
  | 'cancelled'
  | 'busy'
  | 'database_in_use'

export class CoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreError'
  }
}
