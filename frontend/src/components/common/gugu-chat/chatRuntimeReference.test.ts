import { describe, expect, it } from 'vitest'
import { parseChatRuntimeReference, parseMindCanvasChatReference } from './chatRuntimeReference'
import { CHAT_REF_ACCEPTS } from './chatTypes'

describe('GuguChat Runtime 对象引用解析', () => {
  it('把项目卡片拖入聊天时解析成项目引用', () => {
    expect(CHAT_REF_ACCEPTS).toContain('project-card')
    expect(parseChatRuntimeReference('project:42')).toEqual({ type: 'project', id: 42, label: '' })
  })

  it('保留带作用域的文件与文件夹引用解析', () => {
    expect(parseChatRuntimeReference('project-files:file:42')).toEqual({ type: 'file', id: 42, label: '' })
    expect(parseChatRuntimeReference('project-files:folder:7')).toEqual({ type: 'folder', id: 7, label: '' })
  })

  it('拒绝不支持或格式错误的 Runtime 对象 ID', () => {
    expect(parseChatRuntimeReference('event:42')).toBeNull()
    expect(parseChatRuntimeReference('project:not-a-number')).toBeNull()
  })

  it('画布便签和引用卡拖入聊天时保留便签或底层业务对象身份', () => {
    expect(CHAT_REF_ACCEPTS).toContain('mind-canvas-object')
    expect(CHAT_REF_ACCEPTS).toContain('mind-project-object')
    expect(parseMindCanvasChatReference({ id: 12, kind: 'canvas_note', title: '调度逻辑' }))
      .toEqual({ type: 'canvas_note', id: 12, label: '调度逻辑' })
    expect(parseMindCanvasChatReference({
      id: 16, kind: 'canvas_note', title: '旧元数据标题', contentMd: '# Worker 调度逻辑\n\n正文',
    })).toEqual({ type: 'canvas_note', id: 16, label: 'Worker 调度逻辑' })
    expect(parseMindCanvasChatReference({ id: 13, kind: 'ref', refType: 'project', refId: 42, title: '项目甲' }))
      .toEqual({ type: 'project', id: 42, label: '项目甲' })
    expect(parseMindCanvasChatReference({ id: 14, kind: 'ref', refType: 'file', refId: 7 }))
      .toEqual({ type: 'file', id: 7, label: '' })
    expect(parseMindCanvasChatReference({ id: 15, kind: 'ref', refType: 'client', refId: 7 })).toBeNull()
  })

})
