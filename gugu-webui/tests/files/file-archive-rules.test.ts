import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import {
  archiveMimeType,
  buildFolderArchiveEntries,
  MAX_ARCHIVE_ENTRIES,
  MAX_COMPRESS_SOURCE_BYTES,
  MAX_EXTRACT_BYTES,
  nextArchiveName,
  safeArchivePath,
  splitArchiveFilename,
  supportedArchiveFormat,
} from '../../src/domains/files/file-archive-rules.js'

test('归档路径兼容分隔符并拒绝绝对路径、盘符和穿越段', () => {
  assert.equal(safeArchivePath('目录\\子目录\\文件.txt'), '目录/子目录/文件.txt')
  assert.equal(safeArchivePath('./目录/文件.txt'), '目录/文件.txt')
  for (const value of ['../秘密.txt', 'a/../../秘密.txt', '/etc/passwd', 'C:\\temp\\x', 'C:relative', 'nul\0byte']) {
    assert.throws(() => safeArchivePath(value), (error) => error instanceof CoreError && error.code === 'invalid_request')
  }
})

test('解压名称冲突时保留扩展名并递增，文件扩展名统一小写', () => {
  const occupied = new Set(['报告.txt', '报告 (2).txt'])
  assert.deepEqual(splitArchiveFilename('报告.TXT'), { displayName: '报告', ext: 'txt' })
  assert.equal(nextArchiveName('报告.txt', occupied), '报告 (3).txt')
  assert.equal(nextArchiveName('空目录', new Set(['空目录']), true), '空目录 (2)')
})

test('归档规则保留 Python 限额并识别 ZIP 与 TAR 扩展名', () => {
  assert.equal(MAX_COMPRESS_SOURCE_BYTES, 512 * 1024 * 1024)
  assert.equal(MAX_EXTRACT_BYTES, 2 * 1024 * 1024 * 1024)
  assert.equal(MAX_ARCHIVE_ENTRIES, 10_000)
  assert.equal(supportedArchiveFormat('包', 'zip'), 'zip')
  assert.equal(supportedArchiveFormat('backup.tar', 'gz'), 'tar')
  assert.equal(supportedArchiveFormat('backup', 'tgz'), 'tar')
  assert.equal(supportedArchiveFormat('backup', 'rar'), null)
  assert.equal(archiveMimeType('说明.TXT'), 'text/plain')
  assert.equal(archiveMimeType('无扩展名'), 'application/octet-stream')
})

test('选择嵌套文件夹时把被选根目录作为 ZIP 根并保留目录层级', () => {
  const entries = buildFolderArchiveEntries([
    { id: 10, parent_id: 5, root_id: 10, name: '资料' },
    { id: 11, parent_id: 10, root_id: 10, name: '子目录' },
  ], [
    { id: 7, folder_id: 11, display_name: '说明', ext: 'txt', size_bytes: 4, storage_key: 'fake-key' },
  ], new Set(['资料']))

  assert.deepEqual(entries.map((entry) => [entry.archivePath, entry.kind]), [
    ['资料 (2)/', 'folder'],
    ['资料 (2)/子目录/', 'folder'],
    ['资料 (2)/子目录/说明.txt', 'file'],
  ])
})
