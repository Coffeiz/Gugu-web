import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export interface AdminPromptOptions {
  requireAdmin: preHandlerHookHandler
  root: string
  audit: (record: { category: 'prompt'; action: 'update'; profile: string }) => void | Promise<void>
}
const specialProfiles = ['persona', 'skills', 'policy', 'reflection', 'compress'] as const
const profiles = ['default', ...specialProfiles]
const filenames: Record<string, string> = { persona: 'persona.md', skills: 'skills.md', policy: 'policy.md', reflection: 'reflection.md', compress: 'memory_compress.md' }
const placeholders = [
  { key: '{today}', desc: '今天日期' }, { key: '{summary}', desc: '当前状态快照（summary.json）' },
  { key: '{pattern}', desc: '咕咕对用户的行为模式（pattern.json 导出）' }, { key: '{profile}', desc: '咕咕对用户的稳定画像（profile.json 导出）' },
  { key: '{preferences}', desc: '咕咕对用户偏好的理解（preferences.md）' }, { key: '{memory}', desc: '长期认知积累（memory.md）' },
  { key: '{daily}', desc: '近期每日记录' }, { key: '{projects}', desc: '用户当前项目列表' },
  { key: '{calendar}', desc: '近期日历事件' }, { key: '{name}', desc: '用户昵称（identity.json，通常放 persona.md）' },
]
function fail(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  throw error
}
function fileFor(root: string, profile: string): string {
  if (!profiles.includes(profile)) fail(400, '未知提示词 profile')
  const filename = filenames[profile] ?? `${profile}.md`
  const resolvedRoot = resolve(root), path = resolve(resolvedRoot, filename)
  if (basename(path) !== filename || !path.startsWith(resolvedRoot + sep)) fail(400, '提示词路径无效')
  return path
}

export function registerAdminPromptRoutes(app: FastifyInstance, options: AdminPromptOptions): void {
  const preHandler = options.requireAdmin
  app.get('/api/v1/admin/agent/prompts', { preHandler }, async () => {
    await mkdir(options.root, { recursive: true })
    const result = []
    for (const profile of ['persona', 'skills', 'policy', 'reflection', 'compress', 'default']) {
      const path = fileFor(options.root, profile)
      try {
        const info = await stat(path)
        result.push({ profile, exists: info.isFile(), size: info.isFile() ? info.size : 0, ...(profile !== 'default' ? { is_persona: true } : {}) })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('提示词状态读取失败')
        result.push({ profile, exists: false, size: 0, ...(profile !== 'default' ? { is_persona: true } : {}) })
      }
    }
    return { profiles: result, placeholders }
  })
  app.get<{ Params: { profile: string } }>('/api/v1/admin/agent/prompts/:profile', { preHandler }, async (request) => {
    const path = fileFor(options.root, request.params.profile)
    try { return { profile: request.params.profile, content: await readFile(path, 'utf8') } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: request.params.profile, content: '' }
      throw new Error('提示词读取失败')
    }
  })
  app.put<{ Params: { profile: string }; Body: { content?: unknown } }>('/api/v1/admin/agent/prompts/:profile', { preHandler }, async (request) => {
    const path = fileFor(options.root, request.params.profile)
    if (typeof request.body?.content !== 'string') fail(422, '提示词正文必须是文本')
    await mkdir(options.root, { recursive: true })
    const temporary = join(options.root, `.${basename(path)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, request.body.content, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('提示词保存失败')
    }
    await options.audit({ category: 'prompt', action: 'update', profile: request.params.profile })
    return { profile: request.params.profile, saved: true }
  })
}
