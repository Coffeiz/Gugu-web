import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// src 与 dist 的模块层级相同，提示词随 Web Host 包发布。
export const webAgentPromptRoot = fileURLToPath(new URL('../../../../assets/agent-prompts', import.meta.url))

const files = {
  base: 'default.md',
  persona: 'persona.md',
  skills: 'skills.md',
  policy: 'policy.md',
  retrieval: 'retrieval.md',
} as const

export type WebAgentPromptFiles = Record<keyof typeof files, string>

/** 每次 Agent 上下文组装读取当前文件，使 Admin 更新对后续 Run 生效。 */
export function createWebAgentPromptReader(root = webAgentPromptRoot): () => WebAgentPromptFiles {
  const directory = resolve(root)
  return () => Object.fromEntries(Object.entries(files).map(([key, filename]) => {
    try { return [key, readFileSync(resolve(directory, filename), 'utf8')] }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [key, '']
      throw error
    }
  })) as WebAgentPromptFiles
}

export function readWebAgentImPrompt(name: 'group_compress' | 'group_reflection' | 'member_reflection'): Promise<string> {
  return readFile(resolve(webAgentPromptRoot, 'im', `${name}.md`), 'utf8')
}
