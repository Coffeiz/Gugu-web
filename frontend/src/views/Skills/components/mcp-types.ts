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
  }>
}
