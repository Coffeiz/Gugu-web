export type ByokCredentialRow = {
  capability?: string
  enabled?: boolean
  [key: string]: unknown
}

/** 选择某项能力实际应编辑的凭据；启用项优先，兼容历史停用记录。 */
export function pickByokCredential<T extends ByokCredentialRow>(rows: T[], capability: string): T | undefined {
  return rows.find(row => row.capability === capability && row.enabled === true)
    ?? rows.find(row => row.capability === capability)
}
