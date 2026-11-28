// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useChatAttachments } from '@/components/common/gugu-chat/composables/useChatAttachments'

vi.mock('@/services/api', () => ({ agentApi: {} }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

afterEach(() => vi.unstubAllGlobals())

it('录音上传失败时保留原草稿，且不自动发送已有附件', async () => {
  const stopTrack = vi.fn()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } })
  class Recorder {
    static isTypeSupported() { return false }
    mimeType = 'audio/webm'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => Promise<void>
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob(['合成音频']) })
      stopped = this.onstop?.()
    }
  }
  let stopped: Promise<void> | undefined
  vi.stubGlobal('MediaRecorder', Recorder)
  const onVoiceSent = vi.fn()
  const onError = vi.fn()
  const uploadAttachment = vi.fn().mockRejectedValueOnce(new Error('合成上传错误'))
    .mockResolvedValueOnce({ attach_id: 'recording', name: '录音', ext: 'webm' })
  const chat = useChatAttachments({ uploadAttachment, onVoiceSent, onError })
  chat.pendingAtt.value.push({ attach_id: 'draft', name: '已有附件', ext: 'txt' })
  await chat.startRecord()
  chat.stopRecord()
  await stopped
  expect(onError).toHaveBeenCalledOnce()
  expect(onVoiceSent).not.toHaveBeenCalled()
  expect(chat.pendingAtt.value.map(file => file.attach_id)).toEqual(['draft'])
  await chat.startRecord()
  chat.stopRecord()
  await stopped
  expect(onVoiceSent).toHaveBeenCalledOnce()
  expect(stopTrack).toHaveBeenCalledTimes(2)
})

it.each([true, false])('拖放文件按入口选择引用或附件（引用入口：%s）', async asReference => {
  const file = new File(['合成正文'], '文档.txt', { type: 'text/plain' })
  const onDropFiles = vi.fn().mockResolvedValue(undefined)
  const uploadAttachment = vi.fn().mockResolvedValue({ attach_id: 'draft', name: file.name, ext: 'txt' })
  const chat = useChatAttachments({
    ...(asReference ? { onDropFiles } : {}), uploadAttachment, onVoiceSent: vi.fn(), onError: vi.fn(),
  })
  const drop = new Event('drop', { cancelable: true }) as DragEvent
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } })
  await chat.onChatDrop(drop)
  expect(drop.defaultPrevented).toBe(true)
  if (asReference) {
    expect(onDropFiles).toHaveBeenCalledWith([file])
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(chat.pendingAtt.value).toEqual([])
  } else {
    expect(uploadAttachment).toHaveBeenCalledWith(file, undefined)
    expect(chat.pendingAtt.value).toMatchObject([{ attach_id: 'draft' }])
  }
})
