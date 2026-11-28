export type McpDatabaseBackend = 'postgres' | 'sqlite'

export function mcpOwnerKey(owner: string, backend: McpDatabaseBackend): string {
  return backend === 'sqlite' ? owner.replaceAll('-', '') : owner
}

export function mcpJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export function isMcpUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
}
