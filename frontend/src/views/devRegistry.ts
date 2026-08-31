export interface DevToolEntry {
  path?: string
  href?: string
  label: string
  description: string
  eyebrow?: string
  external?: boolean
}

function loopScopeUrl() {
  const configured = import.meta.env.VITE_LOOPSCOPE_URL
  if (configured) return configured
  return `${window.location.protocol}//${window.location.hostname}:4319`
}

export const devToolRegistry: DevToolEntry[] = [
  {
    href: loopScopeUrl(),
    label: 'LoopScope',
    eyebrow: 'AGENT LOOP',
    description: '多 Session 对话、完整 AgentLoop trace、Prompt / LLM draft / Tool / Guard 节点检查。',
    external: true,
  },
  {
    path: '/dev/onboarding',
    label: '新手引导 Demo',
    eyebrow: 'ONBOARDING',
    description: '检查并重建当前登录用户的播种项目与 MP3 分发。',
  },
]
