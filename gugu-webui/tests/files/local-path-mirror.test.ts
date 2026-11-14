import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalPathMirrorMutation } from '../../src/domains/files/local-path-mirror.js'

const owner = '00000000-0000-4000-8000-000000000011'

test('PathMirror rename moves files, preserves the old path until finalize, then prunes empty old dirs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const source = path.join(root, owner, 'personal', 'old', 'nested', 'note.txt')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'synthetic')
  const mutation = createLocalPathMirrorMutation(root, owner, [
    { fromKey: `${owner}/personal/old/nested/note.txt`, toKey: `${owner}/personal/new/nested/note.txt` },
  ], [`${owner}/personal/new`, `${owner}/personal/new/nested`], [`${owner}/personal/old`])
  try {
    await mutation.apply()
    assert.equal(await readFile(path.join(root, owner, 'personal', 'new', 'nested', 'note.txt'), 'utf8'), 'synthetic')
    await mutation.finalize()
    await assert.rejects(readFile(source), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PathMirror rollback restores moved files and prunes newly created destination directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const source = path.join(root, owner, 'personal', 'old', 'note.txt')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'synthetic')
  const mutation = createLocalPathMirrorMutation(root, owner, [
    { fromKey: `${owner}/personal/old/note.txt`, toKey: `${owner}/personal/new/note.txt` },
  ], [`${owner}/personal/new`], [])
  try {
    await mutation.apply()
    await mutation.rollback()
    assert.equal(await readFile(source, 'utf8'), 'synthetic')
    await assert.rejects(readFile(path.join(root, owner, 'personal', 'new', 'note.txt')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PathMirror refuses owner escape and never overwrites a destination file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const source = path.join(root, owner, 'old.txt')
  const target = path.join(root, owner, 'new.txt')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'source')
  await writeFile(target, 'target')
  try {
    const collision = createLocalPathMirrorMutation(root, owner, [
      { fromKey: `${owner}/old.txt`, toKey: `${owner}/new.txt` },
    ], [], [])
    await assert.rejects(collision.apply(), /目标文件已存在/)
    const escaped = createLocalPathMirrorMutation(root, owner, [
      { fromKey: `${owner}/old.txt`, toKey: 'other-owner/new.txt' },
    ], [], [])
    await assert.rejects(escaped.apply(), /与 owner 不匹配/)
    assert.equal(await readFile(source, 'utf8'), 'source')
    assert.equal(await readFile(target, 'utf8'), 'target')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PathMirror removes earlier directories when a later destination directory is unsafe', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const created = path.join(root, owner, 'new-tree')
  const blocked = path.join(root, owner, 'blocked')
  await mkdir(path.dirname(blocked), { recursive: true })
  await writeFile(blocked, 'not a directory')
  const mutation = createLocalPathMirrorMutation(root, owner, [], [
    `${owner}/new-tree`,
    `${owner}/blocked/child`,
  ], [])
  try {
    await assert.rejects(mutation.apply(), /目标目录必须是安全目录/)
    await mutation.rollback()
    await assert.rejects(lstat(created), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PathMirror refuses a symlink root and preserves an existing destination', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const root = path.join(parent, 'root')
  const realRoot = path.join(parent, 'real-root')
  await mkdir(realRoot)
  await symlink(realRoot, root)
  const linkedRootMutation = createLocalPathMirrorMutation(root, owner, [], [], [])
  try {
    await assert.rejects(linkedRootMutation.apply(), /根路径必须是普通目录/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }

  const safeRoot = await mkdtemp(path.join(tmpdir(), 'gugu-path-mirror-'))
  const source = path.join(safeRoot, owner, 'source.txt')
  const destination = path.join(safeRoot, owner, 'destination.txt')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'source')
  const mutation = createLocalPathMirrorMutation(safeRoot, owner, [
    { fromKey: `${owner}/source.txt`, toKey: `${owner}/destination.txt` },
  ], [], [])
  try {
    await writeFile(destination, 'concurrent writer')
    await assert.rejects(mutation.apply(), /目标文件已存在/)
    assert.equal(await readFile(source, 'utf8'), 'source')
    assert.equal(await readFile(destination, 'utf8'), 'concurrent writer')
  } finally {
    await rm(safeRoot, { recursive: true, force: true })
  }
})
