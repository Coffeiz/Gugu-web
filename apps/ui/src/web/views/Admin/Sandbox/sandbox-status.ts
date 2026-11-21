export type SandboxStatus = {
  enabled: boolean
  sandbox_ready: boolean
  runtime_supported: boolean
  execution_backend?: 'bubblewrap'
  runtime_methods: string[]
  readiness_checked: boolean
  shell_enabled: boolean
  shell_dangerous_enabled: boolean
  state: string
  message: string
  network_profile: 'none' | 'egress'
  egress_proxy_configured: boolean
  egress_proxy_url: string
  egress_network_ready: boolean
  egress_config_error: string | null
  egress_available: boolean
  egress_enabled: boolean
}

export function isOfflineOnly(status: SandboxStatus): boolean {
  // 兼容灰度期间仍未返回执行后端标识的 Web Host。
  return status.execution_backend === 'bubblewrap' ||
    (status.runtime_methods.includes('bubblewrap') && !status.egress_network_ready)
}
