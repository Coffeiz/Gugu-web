import type { PreparedToolDefinition } from '../models.js'
import { strip } from '../../shared/values.js'

export type ToolSchemaSelection =
  | { tool_schemas: string[]; rejected: string[] }
  | { error: string; rejected: string[] }

/** available必须来自可信注册器的当前capabilities；此函数不执行工具或扩大授权。 */
export function selectToolSchemas(requested: readonly string[], available: readonly PreparedToolDefinition[]): ToolSchemaSelection {
  const declared: string[] = [], rejected: string[] = []
  const names = available.map(tool => tool.name)
  for (const rawName of requested.slice(0, 12)) {
    const name = strip(rawName)
    if (!name) continue
    const candidates = name.endsWith('*') ? names.filter(candidate => candidate.startsWith(name.slice(0, -1))) : [name]
    let accepted = false
    for (const candidate of candidates) {
      if (declared.includes(candidate) || declared.length >= 12 || !names.includes(candidate)) continue
      declared.push(candidate)
      accepted = true
    }
    // Python保留重复请求的rejected回执；不以“此前已接受”伪造本项成功。
    if (!accepted) rejected.push(name)
  }
  return !declared.length && rejected.length
    ? { error: '没有可获取 Schema 的已授权工具', rejected }
    : { tool_schemas: declared, rejected }
}
