/** 技能页 tab 记忆：路由守卫用它在挂载前重定向，页面用它在显式切换时记录。 */
export const SKILLS_TAB_KEY = 'gugu-skills-tab'

export function lastSkillsTab(): 'mcp' | 'skills' | null {
  const value = localStorage.getItem(SKILLS_TAB_KEY)
  return value === 'mcp' || value === 'skills' ? value : null
}

export function rememberSkillsTab(tab: 'mcp' | 'skills'): void {
  localStorage.setItem(SKILLS_TAB_KEY, tab)
}
