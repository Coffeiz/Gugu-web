// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { FileMeta } from '@/stores/filesCache'
import {
  archiveFormatForFile,
  archiveNameForFile,
  archiveScopeOfFile,
  extractFolderNameForArchive,
  isExtractableArchive,
} from './archive'

describe('文件库归档前端规则', () => {
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

  it('解压文件夹名默认移除完整压缩包后缀', () => {
    const file = (displayName: string, ext: string) => ({ displayName, ext }) as FileMeta
    expect(extractFolderNameForArchive(file('资料.tar', 'gz'))).toBe('资料')
    expect(extractFolderNameForArchive(file('资料', 'tgz'))).toBe('资料')
    expect(extractFolderNameForArchive(file('备份', 'zip'))).toBe('备份')
  })
})
