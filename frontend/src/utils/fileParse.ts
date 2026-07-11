/**
 * 日期 / 文件名解析——纯函数，行为逐字保持：
 *   - doneYear/doneMonth 从 Files/index.vue 抽出（完成项目按年/月分桶）。
 *   - splitName 从 Files/index.vue 与 Projects/ProjectModal.vue 的同款内联 IIFE 抽出（跨文件去重）。
 */

// 项目完成日期取值优先级：doneAt → startDate → createdAt。
type DatedProject = { doneAt?: string | null; startDate?: string | null; createdAt?: string | null }

/** 完成年份分桶：取日期前 4 位；无日期则「未归类」。 */
export function doneYear(p: DatedProject): string {
  return (p.doneAt || p.startDate || p.createdAt || '').slice(0, 4) || '未归类'
}

/** 完成月份分桶：取日期第 5-6 位（MM）；无则 '00'。 */
export function doneMonth(p: DatedProject): string {
  return (p.doneAt || p.startDate || p.createdAt || '').slice(5, 7) || '00'
}

/**
 * 文件名拆成 { base, ext }：以最后一个 '.' 为界，base 为其前、ext 为其后（不含点、不改大小写）；
 * 无 '.' 则 base=整名、ext=''。注意调用方对 ext 另做 toUpperCase（保持原行为，不在此处改大小写）。
 */
export function splitName(filename: string): { base: string; ext: string } {
  const i = filename.lastIndexOf('.')
  return i > -1 ? { base: filename.slice(0, i), ext: filename.slice(i + 1) } : { base: filename, ext: '' }
}
