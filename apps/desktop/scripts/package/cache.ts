import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const ignoredDirectories = new Set(['.git', '.tools', 'coverage', 'dist-desktop', 'node_modules', 'release', 'resources'])

export function fingerprintPaths(paths: string[], salt = '', includeDist = false) {
  const hash = createHash('sha256').update(salt)
  const visited = new Set<string>()

  function visit(path: string) {
    const absolute = resolve(path)
    if (visited.has(absolute)) return
    visited.add(absolute)
    const stats = lstatSync(absolute)
    if (stats.isSymbolicLink()) {
      hash.update(`link\0${absolute}\0${readlinkSync(absolute)}\0`)
      return
    }
    if (stats.isDirectory()) {
      const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || (!includeDist && entry.name === 'dist'))) continue
        visit(resolve(absolute, entry.name))
      }
      return
    }
    if (!stats.isFile()) return
    hash.update(`file\0${absolute}\0`)
    hash.update(readFileSync(absolute))
    hash.update('\0')
  }

  for (const path of paths) visit(path)
  return hash.digest('hex')
}

export function workspaceFingerprintPaths(root: string) {
  return [
    resolve(root, 'package.json'),
    resolve(root, 'pnpm-lock.yaml'),
    resolve(root, 'pnpm-workspace.yaml'),
  ]
}
