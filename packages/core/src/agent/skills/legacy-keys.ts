// 此映射冻结在编号改为动态分配之前，只用于读取旧配置和已保存的回执。
export const legacySkillKeys = new Map([
  ['S1', 'canvas'], ['S2', 'email'], ['S3', 'file-ops'], ['S4', 'im-bind'],
  ['S5', 'image-analysis'], ['S6', 'knowledge-writing'], ['S7', 'chart-and-math'],
  ['S8', 'note-writing'], ['S9', 'project-planning'], ['S12', 'weather'],
  ['S13', 'web-search'], ['S14', 'skill-management'],
])

export function legacyBuiltinSkillKey(id: string): string | undefined {
  return legacySkillKeys.get(id)
}
