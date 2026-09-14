import { describe, expect, it } from 'vitest'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import {
  ARCHIVE_ROOT_VALUE,
  archiveFolderOptions,
  archiveFormatForFile,
  archiveNameForFile,
  archiveScopeOfFile,
  isExtractableArchive,
} from './archive'

describe('文件库归档前端规则', () => {
  it('文件夹目标列表只包含同空间目录，并按完整路径显示', () => {
    const folders = [
      { id: 1, name: '素材', parentId: null, projectId: null, workspaceDirectoryId: null },
      { id: 2, name: '插画', parentId: 1, projectId: null, workspaceDirectoryId: null },
      { id: 3, name: '项目目录', parentId: null, projectId: 99, workspaceDirectoryId: null },
    ] as FolderMeta[]

    expect(archiveFolderOptions(folders, {
      space: 'personal', projectId: null, workspaceDirectoryId: null,
    }, '个人文件根目录')).toEqual([
      { value: ARCHIVE_ROOT_VALUE, label: '个人文件根目录' },
      { value: '1', label: '素材' },
      { value: '2', label: '素材 / 插画' },
    ])
  })

  it('只为支持的压缩格式暴露解压入口，并规范化多段扩展名', () => {
    const file = (displayName: string, ext: string) => ({ displayName, ext }) as FileMeta
    expect(isExtractableArchive(file('资料', 'zip'))).toBe(true)
    expect(isExtractableArchive(file('资料.tar', 'gz'))).toBe(true)
    expect(archiveFormatForFile(file('资料.tar', 'gz'))).toBe('tar.gz')
    expect(archiveFormatForFile(file('资料', 'tgz'))).toBe('tgz')
    expect(isExtractableArchive(file('资料', 'gz'))).toBe(false)
    expect(isExtractableArchive(file('资料', 'rar'))).toBe(false)
    expect(isExtractableArchive(file('资料', '7z'))).toBe(false)
  })

  it('默认归档名称保留多段扩展名的主体，并识别工作区归属', () => {
    const file = { displayName: '资料.tar', ext: 'gz', space: 'workspace', projectId: null, workspaceDirectoryId: 8 } as FileMeta
    expect(archiveNameForFile(file)).toBe('资料.tar')
    expect(archiveScopeOfFile(file)).toEqual({
      space: 'workspace', projectId: null, workspaceDirectoryId: 8,
    })
  })
})
