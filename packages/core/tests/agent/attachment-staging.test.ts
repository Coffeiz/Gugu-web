import { describe, expect, it } from 'vitest'
import { classifyChatAttachment, parseChatAttachmentFilename, planChatAttachmentProcessing, assertChatAttachmentCapacity } from '../../src/agent/attachments/staging.js'

describe('聊天附件暂存规则', () => {
it('分类与 Python 保持扩展名语义，Office 可提取文档归为文本', () => {
  expect(classifyChatAttachment('PNG')).toBe('image')
  expect(classifyChatAttachment('webm')).toBe('audio')
  expect(classifyChatAttachment('mkv')).toBe('video')
  expect(classifyChatAttachment('json')).toBe('text')
  expect(classifyChatAttachment('docx')).toBe('text')
  expect(classifyChatAttachment('svg')).toBe('binary')
  expect(classifyChatAttachment('unknown')).toBe('binary')
})

it('文件名按最后扩展名切分并应用 Python 的空名回退', () => {
  expect(parseChatAttachmentFilename('报告.final.PDF')).toEqual({ name: '报告.final', ext: 'PDF' })
  expect(parseChatAttachmentFilename('.profile')).toEqual({ name: 'file', ext: 'profile' })
  expect(parseChatAttachmentFilename('无后缀')).toEqual({ name: '无后缀', ext: '' })
  expect(parseChatAttachmentFilename(null)).toEqual({ name: 'file', ext: '' })
})

it('仅音频候选触发 materialize，语音超限报错而普通大音频继续流式保存', () => {
  expect(planChatAttachmentProcessing({ ext: 'webm', mime: 'video/webm', size: 8, voice: false, cap: 8 })).toEqual({ needsAudioProcessing: true, materialize: true, transcode: true })
  expect(planChatAttachmentProcessing({ ext: 'pdf', mime: 'application/pdf', size: 8, voice: false, cap: 8 })).toEqual({ needsAudioProcessing: false, materialize: false, transcode: false })
  expect(planChatAttachmentProcessing({ ext: 'aac', mime: 'audio/aac', size: 9, voice: false, cap: 8 })).toEqual({ needsAudioProcessing: true, materialize: false, transcode: false })
  expect(() => planChatAttachmentProcessing({ ext: 'mp3', mime: 'audio/mpeg', size: 9, voice: true, cap: 8 }))
    .toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/语音录音过大/) }))
})

it('聊天附件总容量只允许剩余空间内的大小', () => {
  expect(() => assertChatAttachmentCapacity(7, 3, 10)).not.toThrow()
  expect(() => assertChatAttachmentCapacity(8, 3, 10))
    .toThrow(expect.objectContaining({ statusCode: 413, message: expect.stringMatching(/聊天附件暂存空间已满/) }))
})
})
