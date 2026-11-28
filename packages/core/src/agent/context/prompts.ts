import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const agentPromptDefaults = fileURLToPath(new URL('../../../resources/prompts/', import.meta.url))
export const agentPromptFiles = {
  base: 'default.md',
  persona: 'persona.md',
  skills: 'skills.md',
  policy: 'policy.md',
} as const

/** 缺少覆盖文件时才使用默认模板，空正文仍是管理员保存的值。 */
export function readAgentPrompt(name: string, overrides?: string): string {
  if (!/^(?:im\/)?[a-z_]+\.md$/.test(name)) throw new TypeError('提示词文件名无效')
  if (overrides) {
    try { return readFileSync(resolve(overrides, name), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return readFileSync(resolve(agentPromptDefaults, name), 'utf8')
}

export function readAgentPromptSet(overrides?: string) {
  const { base, persona, skills, policy } = agentPromptFiles
  return {
    base: readAgentPrompt(base, overrides),
    persona: readAgentPrompt(persona, overrides),
    skills: readAgentPrompt(skills, overrides),
    policy: readAgentPrompt(policy, overrides),
  }
}
