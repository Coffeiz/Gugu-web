export class DatabaseError extends Error {
  constructor(readonly code: 'invalid_request' | 'storage_error' | 'schema_upgrade_required', message: string) {
    super(message)
  }
}
