const allowedTools = new Set([
  'xng_search', 'web_search', 'http_get', 'similar_image_search',
  'read_file', 'inspect_images', 'send_file', 'group_context_search',
])

export interface MigrationRow extends Record<string, unknown> {
  id: number
  group_allowed_tools: unknown
}

export interface MigrationClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  release(): void
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>
}

function normalizeGroupTools(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  for (const item of value) {
    const names = item === 'image_search'
      ? ['xng_search', 'similar_image_search']
      : [item]
    for (let name of names) {
      if (typeof name !== 'string' || !allowedTools.has(name)) continue
      if (name === 'inspect_images') name = 'read_file'
      if (!result.includes(name)) result.push(name)
    }
  }
  for (const searchName of ['xng_search', 'web_search']) {
    const index = result.indexOf(searchName)
    if (index >= 0 && !result.includes('http_get')) result.splice(index + 1, 0, 'http_get')
  }
  const imageIndex = result.indexOf('similar_image_search')
  if (imageIndex >= 0 && !result.includes('read_file'))
    result.splice(imageIndex + 1, 0, 'read_file')
  return result
}

/**
 * 显式迁移群工具白名单。数据库事务由本函数拥有；调用方必须在完成
 * 备份和迁移窗口确认后运行，应用启动不会自动执行此写入。
 */
export async function migrateGroupToolPermissions(pool: MigrationPool): Promise<number> {
  const client = await pool.connect()
  let transactionStarted = false
  try {
    await client.query('BEGIN')
    transactionStarted = true
    const { rows: selectedRows } = await client.query(
      'SELECT id, group_allowed_tools FROM user_bots ORDER BY id FOR UPDATE',
    )
    const rows = selectedRows as MigrationRow[]
    let updated = 0
    for (const row of rows) {
      const normalized = normalizeGroupTools(row.group_allowed_tools)
      if (normalized === null || JSON.stringify(normalized) === JSON.stringify(row.group_allowed_tools))
        continue
      await client.query(
        'UPDATE user_bots SET group_allowed_tools = $1 WHERE id = $2',
        [JSON.stringify(normalized), row.id],
      )
      updated++
    }
    await client.query('COMMIT')
    transactionStarted = false
    return updated
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 保留最初迁移错误，避免回滚异常覆盖根因。
      }
    }
    throw error
  } finally {
    client.release()
  }
}
