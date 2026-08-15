/**
 * /dev 索引页读的注册表——以后新加一个 dev 工具页面，只需要在这里加一条，
 * 不需要另外想"入口放哪"。故意保持极简（只有 path/label/description 三个字段）：
 * 现在只有一个工具、是独立的整页应用，还不需要 group/图标/排序这类元信息，
 * 真的需要的时候再加，不要过早设计一套分类系统。
 */
export interface DevToolEntry {
  path: string
  label: string
  description: string
}

export const devToolRegistry: DevToolEntry[] = [
  {
    path: '/dev/onboarding',
    label: '新手引导 Demo',
    description: '触发/重置/重建当前登录用户的新手引导状态。',
  },
]
