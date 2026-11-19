import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { CoreError } from '@gugu/core'
import { avatarFileExtension, type AvatarMediaType, type UserAvatarImage, type UserAvatarOperations } from '../avatar.js'
import { createUserRepository } from './users.js'

interface AvatarRow extends QueryResultRow {
  id: string
  avatar: string | null
}

const mediaTypeByExtension: Record<string, AvatarMediaType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

function inside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}

function relativeAvatarPath(userId: string, value: string | null): string | null {
  if (!value) return null
  const escapedId = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^avatars/${escapedId}\\.(?:[0-9a-f]{32}\\.)?(?:jpg|jpeg|png|webp|gif)$`, 'i')
  return match.test(value) ? value : null
}

async function canonicalAvatarDirectory(storageRoot: string): Promise<{ root: string; directory: string }> {
  await mkdir(path.join(storageRoot, 'avatars'), { recursive: true })
  const root = await realpath(storageRoot)
  const directory = await realpath(path.join(root, 'avatars'))
  if (!inside(root, directory) || directory === root) throw new Error('头像目录不在存储根目录内')
  return { root, directory }
}

async function safeAvatarPath(storageRoot: string, userId: string, value: string | null): Promise<string | null> {
  const relative = relativeAvatarPath(userId, value)
  if (!relative) return null
  let root: string
  try {
    root = await realpath(storageRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const candidate = path.resolve(root, relative)
  if (!inside(root, candidate)) return null
  const directory = path.dirname(candidate)
  const realDirectory = await realpath(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!realDirectory || !inside(root, realDirectory) || realDirectory !== path.join(root, 'avatars')) return null
  return candidate
}

function fileMediaType(filePath: string): AvatarMediaType | null {
  return mediaTypeByExtension[path.extname(filePath).slice(1).toLowerCase()] ?? null
}

export function createPostgresUserAvatarOperations(pool: Pool, storageRoot: string): UserAvatarOperations {
  const users = createUserRepository(pool)
  const absoluteStorageRoot = path.resolve(storageRoot)

  return {
    async upload(ownerId, mediaType, data) {
      const current = await pool.query<AvatarRow>(
        'SELECT id::text, avatar FROM users WHERE id = $1',
        [ownerId],
      )
      const row = current.rows[0]
      if (!row) throw new CoreError('not_found', '用户不存在')

      const { directory } = await canonicalAvatarDirectory(absoluteStorageRoot)
      const filename = `${row.id}.${randomUUID().replaceAll('-', '')}.${avatarFileExtension(mediaType)}`
      const relativePath = `avatars/${filename}`
      const destination = path.join(directory, filename)
      if (!inside(directory, destination)) throw new Error('头像路径无效')
      await writeFile(destination, data, { flag: 'wx', mode: 0o600 })

      const update = await pool.query(
        'UPDATE users SET avatar = $2 WHERE id = $1 RETURNING id',
        [row.id, relativePath],
      )
      if (update.rows.length === 0) {
        await rm(destination, { force: true })
        throw new CoreError('not_found', '用户不存在')
      }

      const previousPath = await safeAvatarPath(absoluteStorageRoot, row.id, row.avatar)
      if (previousPath && previousPath !== destination) {
        await rm(previousPath, { force: true }).catch(() => undefined)
      }

      const user = await users.lookupUser(row.id)
      if (!user) throw new CoreError('not_found', '用户不存在')
      return {
        ...user,
        avatarUrl: `/api/v1/auth/avatar/${row.id}?v=${encodeURIComponent(filename)}`,
      }
    },

    async read(userId): Promise<UserAvatarImage | null> {
      const result = await pool.query<AvatarRow>(
        'SELECT id::text, avatar FROM users WHERE id = $1',
        [userId],
      )
      const row = result.rows[0]
      if (!row || !row.avatar) return null
      const avatarPath = await safeAvatarPath(absoluteStorageRoot, row.id, row.avatar)
      const mediaType = avatarPath ? fileMediaType(avatarPath) : null
      if (!avatarPath || !mediaType) return null
      try {
        const info = await lstat(avatarPath)
        if (!info.isFile() || info.isSymbolicLink()) return null
        return { data: await readFile(avatarPath), mediaType }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
  }
}
