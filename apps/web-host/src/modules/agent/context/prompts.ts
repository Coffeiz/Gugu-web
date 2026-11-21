import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAgentPrompt, readAgentPromptSet, agentPromptFiles } from '@gugu/core/agent/context/prompts'

const legacyRoot = fileURLToPath(new URL('../../../../assets/agent-prompts', import.meta.url))
const legacyFiles = [
  ...Object.values(agentPromptFiles), 'compress_conv.md', 'reflection.md', 'memory_compress.md',
  'profile_compact.md', 'pattern_compact.md',
  'im/group_chat.md', 'im/group_compress.md', 'im/group_reflection.md', 'im/member_reflection.md',
]

export function webAgentPromptRoot(storageRoot: string): string {
  return resolve(storageRoot, '.agent-prompts')
}

/** 从旧部署导入覆盖文件，已保存到新目录的版本优先。 */
export async function migrateWebAgentPrompts(root: string, source = legacyRoot): Promise<void> {
  for (const name of legacyFiles) {
    const content = await readFile(resolve(source, name), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (content === undefined) continue
    const packaged = readAgentPrompt(name)
    if (content === packaged) continue

    const destination = resolve(root, name)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const temp = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
      await link(temp, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(temp, { force: true })
    }
  }
}

export function createWebAgentPromptReader(root?: string): () => ReturnType<typeof readAgentPromptSet> {
  return () => readAgentPromptSet(root)
}

export async function readWebAgentImPrompt(name: 'group_compress' | 'group_reflection' | 'member_reflection', root?: string): Promise<string> {
  return readAgentPrompt(`im/${name}.md`, root)
}
