export interface DevToolEntry {
  path?: string
  href?: string
  label: string
  description: string
  eyebrow?: string
  external?: boolean
}

export const devToolRegistry: DevToolEntry[] = [
  {
    href: import.meta.env.VITE_LOOPSCOPE_URL ?? 'http://127.0.0.1:4319',
    label: 'LoopScope',
    eyebrow: 'AGENT LOOP',
    description: '多 Session 对话、完整 AgentLoop trace、Prompt / LLM draft / Tool / Guard 节点检查。',
    external: true,
  },
  {
    path: '/dev/onboarding',
    label: '新手引导 Demo',
    eyebrow: 'ONBOARDING',
    description: '触发、重置和重建当前登录用户的新手引导状态。',
  },
]
