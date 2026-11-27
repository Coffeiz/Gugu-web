import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { load } = createRequire(require.resolve('electron-updater/package.json'))('js-yaml')
const [action, repository, target, destination] = process.argv.slice(2)
if (!['publish', 'sync'].includes(action) || !/^ghcr\.io\/[a-z0-9][a-z0-9_/-]*\/[a-z0-9][a-z0-9_-]*$/.test(repository ?? '')
  || !/^(darwin|win32)-(arm64|x64)$/.test(target ?? '') || !destination) {
  throw new Error('用法：node scripts/update-feed.mjs publish|sync ghcr.io/<组织>/<包> <平台>-<架构> <目录>')
}
const channel = `stable-${target}`
const metadata = target.startsWith('darwin-') ? 'latest-mac.yml' : 'latest.yml'
const artifactType = 'application/vnd.gugu.desktop.update.v1'
const mediaType = 'application/octet-stream'
const oras = (args, cwd) => execFileSync('oras', args, { cwd, stdio: 'inherit' })
const root = resolve(destination)

async function hash(file) {
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('base64')
}

async function validate(directory) {
  const manifestPath = join(directory, metadata)
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.size > 128 * 1024) throw new Error('更新清单格式无效')
  const manifest = load(await readFile(manifestPath, 'utf8'))
  const { version, files, path, sha512 } = manifest ?? {}
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(files) || !files.length)
    throw new Error('更新清单缺少稳定版本或制品')
  const names = new Set()
  const archive = target.startsWith('darwin-') ? '.zip' : '.exe'
  const entries = await readdir(directory)
  for (const { url, sha512: expected, size } of files) {
    if (typeof url !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(url) || !url.startsWith(`gugu-desktop-${version}-`)
      || !url.includes(`-${target.split('-')[1]}.`) || !entries.includes(url) || names.has(url))
      throw new Error('更新制品名称无效')
    const file = join(directory, url)
    const stat = await lstat(file)
    if (!stat.isFile() || typeof size === 'number' && stat.size !== size || await hash(file) !== expected)
      throw new Error('更新制品校验失败')
    names.add(url)
    const blockmap = url + '.blockmap'
    if (entries.includes(blockmap)) {
      if (!(await lstat(join(directory, blockmap))).isFile()) throw new Error('差分文件格式无效')
      names.add(blockmap)
    }
  }
  if (!files.some(file => file.url === path && file.sha512 === sha512) || ![...names].some(name => name.endsWith(archive)))
    throw new Error('更新清单缺少平台安装制品')
  return { version, names: [...names] }
}

if (action === 'publish') {
  const { version, names } = await validate(root)
  const release = `${repository}:v${version}-${target}`
  oras(['push', release, '--artifact-type', artifactType, ...[metadata, ...names].map(name => `${name}:${mediaType}`)], root)
  oras(['tag', release, channel], root)
} else {
  const stage = await mkdtemp(join(tmpdir(), 'gugu-update-feed-'))
  try {
    oras(['pull', `${repository}:${channel}`, '--output', stage], undefined)
    const { names } = await validate(stage)
    const output = join(root, 'stable', target)
    await mkdir(output, { recursive: true })
    for (const name of names) {
      const existing = await lstat(join(output, name)).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (existing && (!existing.isFile() || await hash(join(output, name)) !== await hash(join(stage, name))))
        throw new Error('已发布的同名制品内容不同，请增加版本号')
    }
    for (const name of [...names, metadata]) {
      const targetPath = join(output, name)
      const temporary = targetPath + '.' + randomUUID() + '.tmp'
      try {
        await copyFile(join(stage, name), temporary)
        await rename(temporary, targetPath)
      } finally {
        await rm(temporary, { force: true })
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
