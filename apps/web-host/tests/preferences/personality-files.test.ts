import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalPreferenceTextFiles } from '../../src/domains/preferences/persistence/personality-files.js'

const ownerId = '00000000-0000-4000-8000-000000000021'

test('Local hidden preference files round-trip atomically and remove empty values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-preferences-'))
  const files = createLocalPreferenceTextFiles(root)
  try {
    assert.equal(await files.read(ownerId, 'personality'), null)
    assert.equal(await files.write(ownerId, 'personality', '仅对当前用户生效'), true)
    assert.equal(await files.read(ownerId, 'personality'), '仅对当前用户生效')
    assert.equal(await files.write(ownerId, 'personality', '仅对当前用户生效'), false)
    assert.equal(await files.write(ownerId, 'personality', null), true)
    assert.equal(await files.read(ownerId, 'personality'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Local hidden preference files reject owner directories redirected by symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-preferences-root-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gugu-preferences-outside-'))
  const files = createLocalPreferenceTextFiles(root)
  try {
    await mkdir(path.join(root, ownerId), { recursive: true })
    await rm(path.join(root, ownerId), { recursive: true, force: true })
    await symlink(outside, path.join(root, ownerId), 'dir')
    await assert.rejects(files.write(ownerId, 'reply-style', '不应写到存储根外'))
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
