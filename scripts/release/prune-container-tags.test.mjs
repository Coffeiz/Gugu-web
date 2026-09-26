import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { planGhcrVersionCleanup, planTagCleanup } from './prune-container-tags.mjs'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const releaseDocsPath = new URL('../../docs/ops/release.md', import.meta.url)

test('只按语义版本保留最新十个正式版本', () => {
  const tags = [
    'latest', 'dev', 'v2.0.0-rc.1', 'v1.9.0', 'v1.10.0', 'v1.2.0',
    ...Array.from({ length: 10 }, (_, index) => `v1.${index}.0`),
  ]
  const result = planTagCleanup(tags)

  assert.equal(result.retained.length, 10)
  assert.deepEqual(result.retained.slice(0, 2), ['v1.10.0', 'v1.9.0'])
  assert.deepEqual(result.obsolete, ['v1.0.0'])
  assert.ok(!result.obsolete.includes('latest'))
  assert.ok(!result.obsolete.includes('dev'))
  assert.ok(!result.obsolete.includes('v2.0.0-rc.1'))
})

test('GHCR 只删除纯过期版本，不碰别名、预发布或同 digest 保留版本', () => {
  const versions = [
    { id: 1, metadata: { container: { tags: ['v1.0.0'] } } },
    { id: 2, metadata: { container: { tags: ['v1.1.0', 'latest'] } } },
    { id: 3, metadata: { container: { tags: ['v1.1.0', 'v1.2.0'] } } },
    { id: 4, metadata: { container: { tags: ['v2.0.0-rc.1'] } } },
    { id: 5, metadata: { container: { tags: ['v1.2.0'] } } },
  ]
  const result = planGhcrVersionCleanup(versions, 1)

  assert.deepEqual(result.obsolete, ['v1.1.0', 'v1.0.0'])
  assert.deepEqual(result.versionIds, [1])
})

test('清理 CI 不删除 GitHub tag 或 GitHub Release', async () => {
  const [workflow, cleanupScript] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./prune-container-tags.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(workflow, /name: Prune old stable container tags[\s\S]*?if: steps\.version\.outputs\.is_stable == 'true'[\s\S]*?node scripts\/release\/prune-container-tags\.mjs/)
  assert.match(workflow, /KEEP_LAST_STABLE_VERSIONS: '10'/)
  assert.match(cleanupScript, /hub\.docker\.com\/v2\/namespaces\/coffeiz\/repositories/)
  assert.match(cleanupScript, /api\.github\.com\/users\/coffeiz\/packages\/container/)
  assert.doesNotMatch(cleanupScript, /gh release delete|git tag -d|refs\/tags/)
  assert.match(await readFile(releaseDocsPath, 'utf8'), /保留最新 10 个/)
})
