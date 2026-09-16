export interface McpServerDraft {
  name: string
  transport: 'http' | 'stdio'
  endpoint: string
  command: string
  timeout_seconds: number
  tool_allowlist: string[]
  confirm_mode: 'auto' | 'confirm_all'
  enabled: boolean
  credential_slots?: Array<{
    id: string
    label: string
    target: 'header' | 'query'
    name: string
    prefix?: string
    // 编辑表单里的明文凭据值；保存时单独抽出为 credential_values 信封加密
    value?: string
  }>
  // 槽位值的明文编辑入口（仅 owner 鉴权后可见可改）；落库前信封加密
  credential_values?: Record<string, string>
}
