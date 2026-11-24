import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import test from 'node:test'
import * as tar from 'tar'
import { createWorkspaceFileReads } from '../../../src/modules/workspaces/files.js'
import { extractTar, extractZip } from '../../../src/modules/files/archive/extract.js'
import { writeZipStreams } from '../../../src/modules/files/archive/write.js'
import { collectPathZipSources } from '../../../src/modules/files/archive/path-sources.js'
import type { createLocalFileTree } from '@gugu/fs/node'

test('路径压缩枚举授权目录且拒绝未列出的路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-archive-path-test-'))
  try {
    const file = path.join(root, 'source')
    await writeFile(file, '正文')
    const tree = {
      async list(value: string) {
        if (value === '') return [{ name: '资料', kind: 'directory', size: 0, relativePath: '资料' }]
        if (value === '资料') return [
          { name: '说明.txt', kind: 'file', size: 6, relativePath: '资料/说明.txt' },
          { name: '记录.txt', kind: 'file', size: 6, relativePath: '资料/记录.txt' },
        ]
        return null
      },
      async open(value: string) { return ['资料/说明.txt', '资料/记录.txt'].includes(value) ? { handle: await open(file, 'r'), size: 6 } : null },
    } as unknown as ReturnType<typeof createLocalFileTree>
    const signal = new AbortController().signal
    const sources = await collectPathZipSources(tree, ['资料'], signal)
    const stage = path.join(root, 'stage'), output = path.join(root, 'result.zip')
    await mkdir(stage)
    await writeZipStreams(sources, output)
    const result = await extractZip(output, stage)
    const extracted = result.members.find(member => member.archivePath === '资料/说明.txt')
    assert.ok(extracted?.stagedPath)
    assert.equal(await readFile(extracted.stagedPath, 'utf8'), '正文')
    const selected = await collectPathZipSources(tree, ['资料/说明.txt', '资料/记录.txt'], signal)
    assert.deepEqual(selected.map(item => item.archivePath), ['说明.txt', '记录.txt'])
    await assert.rejects(collectPathZipSources(tree, ['不存在'], signal), { code: 'not_found' })
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(collectPathZipSources(tree, ['资料'], cancelled.signal), { name: 'AbortError' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('共享 ZIP 写入器保留目录和授权文件流正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-archive-stream-test-'))
  const stage = path.join(root, 'stage')
  try {
    await mkdir(stage)
    const output = path.join(root, 'source.zip')
    const written = await writeZipStreams([
      { archivePath: '资料', kind: 'folder' },
      { archivePath: '资料/说明.txt', kind: 'file', open: () => Readable.from([Buffer.from('正文')]) },
    ], output)
    assert.ok(written.size > 0)
    const result = await extractZip(output, stage)
    const file = result.members.find(member => member.archivePath === '资料/说明.txt')
    assert.ok(file?.stagedPath)
    assert.equal(await readFile(file.stagedPath, 'utf8'), '正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ZIP 输入读取失败时拒绝压缩请求', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-archive-error-test-'))
  try {
    await assert.rejects(writeZipStreams([{
      archivePath: '文件.txt', kind: 'file',
      open: () => Readable.from((async function* () { throw new Error('合成读取失败') })()),
    }], path.join(root, 'result.zip')), /合成读取失败/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('路径压缩发布 ZIP 且冲突时不覆盖已有文件', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-compress-test-'))
  const owner = '11111111-1111-4111-8111-111111111111'
  try {
    const directory = path.join(root, owner, '个人文件', '资料')
    await mkdir(path.join(directory, '子目录'), { recursive: true })
    await writeFile(path.join(directory, '子目录', '说明.txt'), '合成正文')
    const files = createWorkspaceFileReads({ query: async () => { throw new Error('不应读取旧表') } } as never, root)
    const signal = new AbortController().signal
    assert.deepEqual(await files.compressArchive(owner, 'personal', ['资料/子目录'], '归档', signal), { relativePath: '资料/归档.zip' })
    const stage = path.join(root, 'stage')
    await mkdir(stage)
    const result = await extractZip(path.join(directory, '归档.zip'), stage)
    const file = result.members.find(member => member.archivePath === '子目录/说明.txt')
    assert.ok(file?.stagedPath)
    assert.equal(await readFile(file.stagedPath, 'utf8'), '合成正文')
    const downloaded = await files.downloadArchive(owner, 'personal', ['资料/子目录'], signal)
    const downloadPath = path.join(root, 'download.zip')
    await pipeline(downloaded, createWriteStream(downloadPath))
    const downloadStage = path.join(root, 'download-stage')
    await mkdir(downloadStage)
    const downloadResult = await extractZip(downloadPath, downloadStage)
    const downloadFile = downloadResult.members.find(member => member.archivePath === '子目录/说明.txt')
    assert.ok(downloadFile?.stagedPath)
    assert.equal(await readFile(downloadFile.stagedPath, 'utf8'), '合成正文')
    await assert.rejects(files.compressArchive(owner, 'personal', ['资料/子目录'], '归档', signal), { code: 'conflict' })
    await assert.rejects(files.compressArchive(owner, 'personal', ['资料/子目录', '其他/文件'], '其他', signal), { code: 'invalid_request' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('解压器可读取 Node 归档器生成的 ZIP 目录树和文件正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-archive-zip-test-'))
  const stage = path.join(root, 'stage')
  const archive = path.join(root, 'source.zip')
  try {
    await mkdir(stage)
    const zip = new JSZip()
    zip.folder('资料')
    zip.folder('资料/子目录')
    zip.file('资料/子目录/说明.txt', 'zip-content', { binary: true, createFolders: false })
    await pipeline(zip.generateNodeStream({
      type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 },
    }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }))

    const result = await extractZip(archive, stage)
    assert.deepEqual(result.members.map(({ archivePath, kind }) => [archivePath, kind]), [
      ['资料', 'folder'], ['资料/子目录', 'folder'], ['资料/子目录/说明.txt', 'file'],
    ])
    const file = result.members.find((member) => member.archivePath === '资料/子目录/说明.txt')
    assert.ok(file?.stagedPath)
    assert.equal(await readFile(file.stagedPath, 'utf8'), 'zip-content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('解压器读取 TAR.GZ 流并保留嵌套目录与文件正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-archive-tar-test-'))
  const source = path.join(root, 'source')
  const stage = path.join(root, 'stage')
  const archive = path.join(root, 'source.tar.gz')
  try {
    const file = path.join(source, '资料', '子目录', '说明.txt')
    await mkdir(path.dirname(file), { recursive: true })
    await mkdir(stage)
    await writeFile(file, 'tar-gzip-content')
    await tar.c({ cwd: source, file: archive, gzip: true }, ['资料'])

    const result = await extractTar(archive, stage, true)
    const directory = result.members.find((member) => member.archivePath === '资料/子目录' && member.kind === 'folder')
    const textFile = result.members.find((member) => member.archivePath === '资料/子目录/说明.txt')
    assert.ok(directory)
    assert.ok(textFile?.stagedPath)
    assert.equal(await readFile(textFile.stagedPath, 'utf8'), 'tar-gzip-content')
    assert.equal(result.skipped, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('路径解压原子发布整个目录，冲突时保留原目录与压缩包', {
  skip: process.platform !== 'linux' && '路径服务需要 Linux',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-extract-test-'))
  const owner = '11111111-1111-4111-8111-111111111111'
  const ownerRoot = path.join(root, owner)
  const directory = path.join(ownerRoot, '个人文件', '资料')
  const signal = new AbortController().signal
  const files = createWorkspaceFileReads({ query: () => assert.fail('个人路径解压无需查询旧文件表') }, root)
  try {
    await mkdir(directory, { recursive: true })
    const zip = new JSZip()
    zip.file('子目录/说明.txt', '压缩包正文')
    const original = await zip.generateAsync({ type: 'nodebuffer' })
    await writeFile(path.join(directory, '资料.zip'), original)
    assert.deepEqual(await files.extractArchive(owner, 'personal', '资料/资料.zip', '解压结果', signal),
      { relativePath: '资料/解压结果', skipped: 0 })
    const extracted = path.join(directory, '解压结果', '子目录', '说明.txt')
    assert.equal(await readFile(extracted, 'utf8'), '压缩包正文')
    await writeFile(extracted, '用户已修改')
    await assert.rejects(files.extractArchive(owner, 'personal', '资料/资料.zip', '解压结果', signal), { code: 'conflict' })
    assert.equal(await readFile(extracted, 'utf8'), '用户已修改')
    assert.deepEqual(await readFile(path.join(directory, '资料.zip')), original)
    assert.deepEqual(await readdir(ownerRoot), ['个人文件'])
    await assert.rejects(files.extractArchive(owner, 'personal', '资料/资料.zip', '../越权', signal), { code: 'invalid_request' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
