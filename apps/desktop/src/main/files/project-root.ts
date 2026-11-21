import { lstat, mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DesktopProjectDetails } from '@gugu/core/desktop'
import { projectFileDirectory } from '@gugu/core/project-file-paths'
import { DesktopError } from '../core-host.js'

export type ReadProjectFilesMetadata = (id: number) => Promise<Pick<DesktopProjectDetails, 'name' | 'startDate' | 'createdAt' | 'deletedAt'>>

async function directoryExists(path: string) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && !info.isDirectory()) throw new DesktopError('forbidden', '项目目录无效')
  return info !== null
}

async function childDirectories(path: string) {
  if (!await directoryExists(path)) return []
  return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

async function existingProjectDirectories(root: string, id: number) {
  const suffix = ` #${id}`
  const children = await childDirectories(root)
  const matches = (parent: string, names: string[]) =>
    names.filter(name => name.endsWith(suffix)).map(name => join(parent, name))
  const result = matches(root, children)
  for (const yearName of children.filter(name => /^\d{4}$/.test(name))) {
    const year = join(root, yearName)
    const months = (await childDirectories(year)).filter(name => /^(0[1-9]|1[0-2])$/.test(name))
    for (const month of months) {
      const parent = join(year, month)
      result.push(...matches(parent, await childDirectories(parent)))
    }
  }
  return result
}

export async function resolveProjectFileRoot(
  root: string, id: number, project: Awaited<ReturnType<ReadProjectFilesMetadata>>, create: boolean,
) {
  const date = project.startDate || project.createdAt
  const normalizedDate = /^\d{4}-(0[1-9]|1[0-2])-/.test(date) ? date : ''
  const name = project.name.replace(/[\x00-\x1f]/g, '_')
  const [, ...parts] = projectFileDirectory(name, id, normalizedDate).split('/')
  const target = join(root, ...parts)
  if (!await directoryExists(root)) {
    if (!create) return null
    await mkdir(root, { recursive: true })
  }
  let cursor = root
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part)
    if (!await directoryExists(cursor)) break
  }
  if (await directoryExists(target)) return target

  const previous = await existingProjectDirectories(root, id)
  if (previous.length > 1) throw new DesktopError('conflict', '发现多个同一项目的目录，请先在系统中整理')
  if (!create && !previous.length) return null
  await mkdir(dirname(target), { recursive: true })
  if (previous[0]) await rename(previous[0], target)
  else await mkdir(target, { recursive: true })
  return target
}
