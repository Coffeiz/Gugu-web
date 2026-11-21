import { describe, expect, it, vi } from 'vitest'
import type { MindNote } from '@/services/api'
import { persistMindNoteDraft } from '@/views/Mind/utils/noteDraft'

function createdNote(): MindNote {
  return {
    id: 1, kind: 'note', title: null, contentMd: '正文', color: null,
    capturedAt: '2026-10-06T00:00:00.000Z', version: 1,
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  }
}

describe('三栏笔记的新建草稿持久化', () => {
  it('新建后未输入或只输入空白就离开，不向服务端创建空笔记', async () => {
    const createNote = vi.fn(async () => createdNote())
    const draft = { capturedAt: '2026-10-06T00:00:00.000Z' }

    expect(persistMindNoteDraft(draft, '', null, createNote)).toBeNull()
    expect(persistMindNoteDraft(draft, ' \n\t ', null, createNote)).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
  })

  it('有正文时只创建一条记录，并保留草稿原定记录时间', async () => {
    const createNote = vi.fn(async () => createdNote())
    const draft = { capturedAt: '2026-09-07T08:30:00.000Z' }

    await expect(persistMindNoteDraft(draft, '# 标题\n正文', '标题', createNote)).resolves.toEqual(createdNote())
    expect(createNote).toHaveBeenCalledOnce()
    expect(createNote).toHaveBeenCalledWith({ contentMd: '# 标题\n正文', title: '标题', capturedAt: draft.capturedAt })
  })

  it('仅填写标题也会持久化为有意义的笔记', async () => {
    const createNote = vi.fn(async () => createdNote())
    const draft = { capturedAt: '2026-09-07T08:30:00.000Z' }

    await expect(persistMindNoteDraft(draft, '', '只有标题', createNote)).resolves.toEqual(createdNote())
    expect(createNote).toHaveBeenCalledWith({ contentMd: '', title: '只有标题', capturedAt: draft.capturedAt })
  })
})
