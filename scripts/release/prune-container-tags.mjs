import { appendFileSync } from 'node:fs'

const stableVersionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const registries = {
  ghcr: ['gugu-web', 'gugu-web-backend', 'gugu-web-frontend', 'gugu-sandbox'],
  dockerHub: ['gugu-web', 'gugu-web-backend', 'gugu-web-frontend', 'gugu-sandbox'],
}

function parseStableVersion(tag) {
  const match = stableVersionPattern.exec(tag)
  return match ? match.slice(1).map(BigInt) : null
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? -1 : 1
  }
  return 0
}

export function planTagCleanup(tags, keepLast = 10) {
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    throw new RangeError('keepLast 必须是正整数')
  }
  const stableTags = [...new Set(tags)].filter(tag => parseStableVersion(tag))
  stableTags.sort((left, right) => compareVersions(parseStableVersion(left), parseStableVersion(right)))
  const retained = new Set(stableTags.slice(0, keepLast))
  return { retained: [...retained], obsolete: stableTags.filter(tag => !retained.has(tag)) }
}

export function planGhcrVersionCleanup(versions, keepLast = 10) {
  const tags = versions.flatMap(version => version.metadata?.container?.tags ?? [])
  const plan = planTagCleanup(tags, keepLast)
  const obsolete = new Set(plan.obsolete)
  const versionIds = versions.flatMap(version => {
    const versionTags = version.metadata?.container?.tags ?? []
    const stableTags = versionTags.filter(tag => parseStableVersion(tag))
    if (stableTags.length === 0 || !stableTags.every(tag => obsolete.has(tag))) return []
    if (versionTags.some(tag => !parseStableVersion(tag))) return []
    return [version.id]
  })
  return { ...plan, versionIds }
}

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `${lines.join('\n')}\n`)
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${url} 返回 HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

async function listDockerHubTags(repository, token) {
  const tags = []
  let url = `https://hub.docker.com/v2/namespaces/coffeiz/repositories/${repository}/tags?page_size=100`
  while (url) {
    if (new URL(url).origin !== 'https://hub.docker.com') throw new Error('Docker Hub 分页地址越界')
    const page = await requestJson(url, { headers: { authorization: `Bearer ${token}` } })
    tags.push(...(page.results ?? []).map(tag => tag.name).filter(Boolean))
    url = page.next
  }
  return tags
}

async function pruneDockerHub(repository, token, keepLast) {
  const plan = planTagCleanup(await listDockerHubTags(repository, token), keepLast)
  for (const tag of plan.obsolete) {
    const url = `https://hub.docker.com/v2/namespaces/coffeiz/repositories/${repository}/tags/${encodeURIComponent(tag)}`
    await requestJson(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  }
  return plan
}

async function listGhcrVersions(packageName, token) {
  const versions = []
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/users/coffeiz/packages/container/${packageName}/versions`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    const batch = await requestJson(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    })
    versions.push(...batch)
    if (batch.length < 100) return versions
  }
}

async function pruneGhcr(packageName, token, keepLast) {
  const versions = await listGhcrVersions(packageName, token)
  const plan = planGhcrVersionCleanup(versions, keepLast)

  for (const versionId of plan.versionIds) {
    await requestJson(
      `https://api.github.com/users/coffeiz/packages/container/${packageName}/versions/${versionId}`,
      {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    )
  }
  return { ...plan, deleted: plan.versionIds.length }
}

async function createDockerHubToken(username, secret) {
  const payload = await requestJson('https://hub.docker.com/v2/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, secret }),
  })
  if (!payload.access_token) throw new Error('Docker Hub 未返回访问令牌')
  return payload.access_token
}

async function main() {
  const keepLast = Number(process.env.KEEP_LAST_STABLE_VERSIONS ?? 10)
  const ghcrToken = process.env.GITHUB_TOKEN
  const dockerHubUsername = process.env.DOCKERHUB_USERNAME
  const dockerHubSecret = process.env.DOCKERHUB_TOKEN
  const failures = []
  const summary = ['### 容器镜像旧版本清理', `- 稳定版本保留数：${keepLast}`]
  if (!ghcrToken || !dockerHubUsername || !dockerHubSecret) throw new Error('缺少镜像清理所需的 registry 凭据')

  let dockerHubToken
  try {
    dockerHubToken = await createDockerHubToken(dockerHubUsername, dockerHubSecret)
  } catch (error) {
    failures.push(`Docker Hub 认证失败：${error.message}`)
  }
  for (const repository of registries.ghcr) {
    try {
      const result = await pruneGhcr(repository, ghcrToken, keepLast)
      summary.push(`- GHCR ${repository}：保留 ${result.retained.length} 个，删除 ${result.deleted} 个旧稳定版本 tag`)
    } catch (error) {
      failures.push(`GHCR ${repository} 清理失败：${error.message}`)
    }
  }
  if (dockerHubToken) {
    for (const repository of registries.dockerHub) {
      try {
        const result = await pruneDockerHub(repository, dockerHubToken, keepLast)
        summary.push(`- Docker Hub ${repository}：保留 ${result.retained.length} 个，删除 ${result.obsolete.length} 个旧稳定版本 tag`)
      } catch (error) {
        failures.push(`Docker Hub ${repository} 清理失败：${error.message}`)
      }
    }
  }
  summary.push('- `latest`、`dev`、预发布及其他非稳定版本 tag 不参与清理')
  if (failures.length) {
    summary.push('', '清理告警（不影响本次发布）：', ...failures.map(message => `- ${message}`))
    console.warn(failures.map(message => `[镜像清理告警] ${message}`).join('\n'))
  }
  appendSummary(summary)
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(error => {
    console.error(`[镜像清理失败] ${error.message}`)
    process.exitCode = 1
  })
}
