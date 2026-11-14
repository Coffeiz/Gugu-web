import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as tar from 'tar'
import { extractTar } from '../../src/domains/files/file-archive-postgres.js'

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
