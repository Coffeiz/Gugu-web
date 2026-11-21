import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DESKTOP_CHANNELS, type DesktopAgentAttachment } from '@gugu/core/desktop'
import { desktopAgentAttachmentHandlers } from '../src/main/agent/attachments.js'

it('Desktop 附件桥安全暂存字节，并且仅删除仍处于草稿态的物理文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-upload-'))
  const staged = new Map<string, string>()
  const host = { async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'agent.attachments.stage') {
      const input = params.attachment as { attachId: string; name: string; ext: string; mime: string | null; size: number; voice: boolean }
      staged.set(input.attachId, `agent-attachments/${input.attachId}`)
      return { attach_id: input.attachId, name: input.name, ext: input.ext, size: input.size,
        kind: input.voice ? 'voice' : 'text', mime: input.mime, duration: null, img_width: null, img_height: null, upload: true } as T
    }
    if (method === 'agent.attachments.deleteDraft') return (staged.get(String(params.attach_id)) ?? null) as T
    if (method === 'agent.attachments.download') {
      const attachId = String(params.attach_id)
      return { storageKey: `agent-attachments/${attachId}`, name: '设计稿', ext: 'txt', mime: 'text/plain', size: 18 } as T
    }
    throw new Error('unexpected host method')
  } }
  try {
    const upload = desktopAgentAttachmentHandlers(host as never, directory)[DESKTOP_CHANNELS.agentAttachment]!
    const data = new TextEncoder().encode('合成附件正文')
    const attachment = await upload({ action: 'upload', name: '设计稿.txt', mime: 'text/plain', voice: false, data }) as DesktopAgentAttachment
    expect(attachment).toMatchObject({ name: '设计稿', ext: 'txt', size: data.length })
    const path = join(directory, 'agent-attachments', attachment.attach_id)
    expect(await readFile(path, 'utf8')).toBe('合成附件正文')
    const downloaded = await upload({ action: 'download', attachId: attachment.attach_id }) as { name: string; mime: string; data: Uint8Array }
    expect(downloaded).toMatchObject({ name: '设计稿.txt', mime: 'text/plain' })
    expect(new TextDecoder().decode(downloaded.data)).toBe('合成附件正文')
    await upload({ action: 'deleteDraft', attachId: attachment.attach_id })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
