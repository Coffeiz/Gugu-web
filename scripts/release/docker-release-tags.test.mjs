import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)

test('正式镜像只发布语义版本号标签，Git SHA 仅保留为构建元数据', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:\n'))
  const imageTagLines = publishJob.split('\n').filter(line =>
    /^\s*\$\{\{\s*env\.[A-Z_]+\s*\}\}[^\n]*:\$\{\{/.test(line),
  )

  assert.equal(imageTagLines.length, 8, '预期 backend、frontend、app、updater、sandbox 发布共八个版本标签')
  assert.ok(imageTagLines.every(line => line.includes('steps.version.outputs.version')))
  assert.ok(imageTagLines.every(line => !line.includes('github.sha')))
  assert.match(publishJob, /GIT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/, 'manifest 仍应记录构建 commit SHA')
  assert.match(publishJob, /--tag "\$\{IMAGE_REPOSITORY\}:latest"/, '稳定版需继续更新默认部署使用的 latest 别名')
})
