import { describe, expect, it } from 'vitest'
import { resolveRelativeFileLink } from './fileLinks'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'

const folders = [
  { id: 1, name: '2026', parentId: null, projectId: 7, fileCount: 1, version: 1 },
  { id: 2, name: '剧情', parentId: 1, projectId: 7, fileCount: 1, version: 1 },
] as FolderMeta[]

const files = [
  { id: 10, displayName: '海边的曼彻斯特', ext: 'md', folderId: 2, projectId: 7 },
  { id: 11, displayName: '根目录说明.md', ext: 'md', folderId: null, projectId: 7 },
] as FileMeta[]

describe('resolveRelativeFileLink', () => {
  it('resolves a project-relative markdown file path', () => {
    const result = resolveRelativeFileLink('2026/剧情/海边的曼彻斯特.md', { projectId: 7 }, files, folders)
    expect(result).toEqual({ kind: 'file', file: files[0] })
  })

  it('resolves a path relative to the current folder', () => {
    const result = resolveRelativeFileLink('剧情/海边的曼彻斯特.md', { folderId: 1, projectId: 7 }, files, folders)
    expect(result).toEqual({ kind: 'file', file: files[0] })
  })

  it('resolves folders and keeps different projects isolated', () => {
    const result = resolveRelativeFileLink('2026/剧情', { projectId: 7 }, files, folders)
    expect(result).toEqual({ kind: 'folder', folder: folders[1] })
    expect(resolveRelativeFileLink('2026/剧情/海边的曼彻斯特.md', { projectId: 8 }, files, folders)).toBeNull()
  })

  it('does not take over external or unsafe links', () => {
    for (const href of ['https://example.com/a.md', 'mailto:test@example.com', '#section', 'javascript:alert(1)']) {
      expect(resolveRelativeFileLink(href, { projectId: 7 }, files, folders)).toBeNull()
    }
  })
})
