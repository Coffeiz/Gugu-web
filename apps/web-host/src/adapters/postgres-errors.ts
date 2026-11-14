/** 判断 PostgreSQL 是否报告唯一约束冲突（SQLSTATE 23505）。 */
export function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === '23505'
}
