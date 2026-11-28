import { readFile, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
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

it('桌面附件从本机源路径流式落盘：单个文件不再受 32MB 的 IPC 传输上限约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-upload-path-'))
  const source = join(directory, '来源.bin')
  const size = 36 * 1024 * 1024
  await writeFile(source, Buffer.alloc(size, 7))
  const host = { async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'agent.attachments.stage') {
      const input = params.attachment as { attachId: string; name: string; ext: string; mime: string | null; size: number; voice: boolean }
      return { attach_id: input.attachId, name: input.name, ext: input.ext, size: input.size,
        kind: input.voice ? 'voice' : 'text', mime: input.mime, duration: null, img_width: null, img_height: null, upload: true } as T
    }
    throw new Error('unexpected host method')
  } }
  try {
    const upload = desktopAgentAttachmentHandlers(host as never, directory)[DESKTOP_CHANNELS.agentAttachment]!
    const attachment = await upload({ action: 'upload', name: '大文件.bin', mime: 'application/octet-stream',
      voice: false, sourcePath: source }) as DesktopAgentAttachment
    expect(attachment).toMatchObject({ size })
    const path = join(directory, 'agent-attachments', attachment.attach_id)
    expect((await stat(path)).size).toBe(size)
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(4)
      await handle.read(head, 0, head.length, 0)
      expect([...head]).toEqual([7, 7, 7, 7])
    } finally { await handle.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
