import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { readAgentPrompt } from '@gugu/core/agent/context/prompts'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface AdminPromptOptions {
  requireAdmin: preHandlerHookHandler
  root: string
  adminUsername(request: FastifyRequest): string
  writeAuditLog(username: string, action: 'prompt', description: string, request: FastifyRequest): Promise<void>
}

const specialProfiles = ['persona', 'skills', 'policy', 'reflection', 'compress'] as const
const filenames: Record<string, string> = {
  persona: 'persona.md', skills: 'skills.md', policy: 'policy.md', reflection: 'reflection.md', compress: 'memory_compress.md',
}
const placeholders = [
  { key: '{today}', desc: '今天日期' }, { key: '{summary}', desc: '当前状态快照（summary.json）' },
  { key: '{pattern}', desc: '咕咕对用户的行为模式（pattern.json 导出）' }, { key: '{profile}', desc: '咕咕对用户的稳定画像（profile.json 导出）' },
  { key: '{preferences}', desc: '咕咕对用户偏好的理解（preferences.md）' }, { key: '{memory}', desc: '长期认知积累（memory.md）' },
  { key: '{daily}', desc: '近期每日记录' }, { key: '{projects}', desc: '用户当前项目列表' },
  { key: '{calendar}', desc: '近期日历事件' }, { key: '{name}', desc: '用户昵称（identity.json，通常放 persona.md）' },
]

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode })
}

function fileFor(root: string, profile: string): string {
  if (profile !== 'default' && !specialProfiles.includes(profile as typeof specialProfiles[number])) fail(400, '未知提示词 profile')
  const filename = filenames[profile] ?? `${profile}.md`
  const resolvedRoot = resolve(root), path = resolve(resolvedRoot, filename)
  if (basename(path) !== filename || !path.startsWith(resolvedRoot + sep)) fail(400, '提示词路径无效')
  return path
}

/** Admin 提示词只允许读写固定的运行时文件；正文不进入审计记录。 */
export function registerAdminPromptRoutes(app: FastifyInstance, options: AdminPromptOptions): void {
  app.get('/api/v1/admin/agent/prompts', { preHandler: options.requireAdmin }, async () => {
    const orderedProfiles = [...specialProfiles, 'default'] as const
    const profiles = await Promise.all(orderedProfiles.map(async profile => {
      const path = fileFor(options.root, profile)
      try {
        const content = readAgentPrompt(basename(path), options.root)
        return { profile, exists: true, size: Buffer.byteLength(content), ...(profile !== 'default' ? { is_persona: true } : {}) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('提示词状态读取失败')
        return { profile, exists: false, size: 0, ...(profile !== 'default' ? { is_persona: true } : {}) }
      }
    }))
    return { profiles, placeholders }
  })

  app.get<{ Params: { profile: string } }>('/api/v1/admin/agent/prompts/:profile', { preHandler: options.requireAdmin }, async request => {
    const path = fileFor(options.root, request.params.profile)
    try { return { profile: request.params.profile, content: readAgentPrompt(basename(path), options.root) } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: request.params.profile, content: '' }
      throw new Error('提示词读取失败')
    }
  })

  app.put<{ Params: { profile: string }; Body: { content?: unknown } }>('/api/v1/admin/agent/prompts/:profile', { preHandler: options.requireAdmin }, async (request, reply) => {
    const path = fileFor(options.root, request.params.profile)
    if (typeof request.body?.content !== 'string') return reply.code(422).send({ detail: '提示词正文必须是文本' })
    await mkdir(options.root, { recursive: true, mode: 0o700 })
    const temporary = join(options.root, `.${basename(path)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, request.body.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('提示词保存失败')
    }
    await options.writeAuditLog(options.adminUsername(request), 'prompt', `更新 Agent 提示词：${request.params.profile}`, request)
    return { profile: request.params.profile, saved: true }
  })
}
