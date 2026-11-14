import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createOnboardingSurpriseMp3Reader } from '../../src/domains/onboarding/surprise-asset.js'

test('选择文件名排序后的首个 MP3 并返回无扩展名文件名', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-onboarding-assets-test-'))
  const assets = path.join(root, 'assets')
  await mkdir(assets)
  try {
    await writeFile(path.join(assets, 'z-last.mp3'), 'last')
    await writeFile(path.join(assets, 'a-first.MP3'), 'first')
    await writeFile(path.join(assets, 'ignore.txt'), 'ignored')
    assert.deepEqual(await createOnboardingSurpriseMp3Reader(assets)(), {
      name: 'a-first', data: Buffer.from('first'),
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('缺少可选素材目录或 MP3 时返回空值', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-onboarding-assets-empty-'))
  try {
    assert.equal(await createOnboardingSurpriseMp3Reader(path.join(root, 'missing'))(), null)
    assert.equal(await createOnboardingSurpriseMp3Reader(root)(), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
