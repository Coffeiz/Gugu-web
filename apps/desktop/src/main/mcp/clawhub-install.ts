import { createClawHubDownload, createUserSkillDocument, stageSkillPackage } from '@gugu/core/skills'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import type { ProxyEndpoint } from '@gugu/core/providers/node'
import { randomUUID } from 'node:crypto'
import { DesktopError } from '../core-host.js'

/** 下载和暂存交给共享层，发布及文件历史由桌面文件服务负责。 */
export function createDesktopClawHubInstaller(options: {
  dataRoot: string
  ownerId: string
  commit(stagedDirectory: string, slug: string, storageSource: 'user' | 'clawhub'): Promise<unknown>
  resolveProxy?: (url: URL, signal: AbortSignal) => Promise<ProxyEndpoint | undefined>
  download?: (reference: string, signal: AbortSignal) => Promise<ReadonlyMap<string, Uint8Array>>
}) {
  return async (reference: string) => {
    const match = /^@?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u.exec(reference)
    if (!match) throw new DesktopError('invalid_request', '技能来源无效')
    const slug = match[1]!
    const signal = AbortSignal.timeout(30_000)
    const transport = options.download ? null : createNodeProviderTransport(desktopTransportOptions(false, options.resolveProxy))
    try {
      const files = await (options.download ?? createClawHubDownload(transport!))(reference, signal)
      await stageSkillPackage({ dataRoot: options.dataRoot, ownerId: options.ownerId, slug, files, signal, storageSource: 'clawhub',
        commit: input => options.commit(input.stagedDirectory, input.slug, 'clawhub') })
      return { id: slug }
    } finally { await transport?.close() }
  }
}

/** 新建技能复用安装时的暂存和文件历史。 */
export function createDesktopFileSkillCreator(options: {
  dataRoot: string
  ownerId: string
  commit(stagedDirectory: string, slug: string, storageSource: 'user' | 'clawhub'): Promise<unknown>
  tools(): Promise<ReadonlySet<string>>
}) {
  return async (fields: { name: string; description_short: string; description_long: string | null; category: string; body: string; related_tools: string[]; enabled?: boolean }) => {
    const source = createUserSkillDocument(fields, await options.tools())
    const slug = `skill-${randomUUID()}`
    await stageSkillPackage({ dataRoot: options.dataRoot, ownerId: options.ownerId, slug,
      files: new Map([['SKILL.md', Buffer.from(source)]]), signal: AbortSignal.timeout(30_000),
      commit: input => options.commit(input.stagedDirectory, input.slug, 'user') })
    return { id: slug }
  }
}
