import { randomUUID } from 'node:crypto'
import { link, open, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Pool } from 'pg'
import { CoreError } from '@gugu/core'
import { openAnchoredLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { resolveConfigOverridePath } from '../src/adapters/config/config-override-file.js'
import { loadConfig } from '../src/config.js'
import { isOwnedFileStorageKey, normalizeFileOwnerId } from '../src/modules/files/store.js'
import { readPostgresProjectPathMirrorKey } from '../src/modules/files/folders/paths.js'
import { originalStorageKey } from '../src/modules/files/trash/service.js'
import { resolveFileDirectoryRoot, type FileDirectory } from '../src/modules/workspaces/files.js'
import { personalFileStorageKey, workspaceDirectoryStorageKey } from '../src/modules/workspaces/roots.js'

type FileRow = {
  id: number
  user_id: string
  space: string
  storage_key: string
  size_bytes: string
  deleted_at: Date | null
  stage_name: string
  display_name: string
  ext: string
  folder_id: number | null
  mind_map_id: number | null
  workspace_directory_id: number | null
  project_id: number | null
  directory_name: string | null
}

async function record(manifest: FileHandle | null, value: unknown) {
  if (manifest) await manifest.writeFile(`${JSON.stringify(value)}\n`)
}

async function inspect(manifest: FileHandle | null) {
  if (process.platform !== 'linux') throw new Error('文件迁移预检需要 Linux')
  const config = loadConfig(process.env, resolveConfigOverridePath(process.env))
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await record(manifest, { kind: 'header', version: 2, createdAt: new Date().toISOString() })
      const groups = new Map<string, {
        total: number; inPlace: number; needsPlacement: number; missing: number; unsafe: number
        sizeMismatch: number; stageTag: number
      }>()
      let cursor = 0
      while (true) {
        const { rows } = await client.query<FileRow>(
          `SELECT f.id, f.user_id, f.space, f.storage_key, f.size_bytes, f.deleted_at, f.stage_name, f.project_id,
                  f.display_name, f.ext, f.folder_id, f.mind_map_id, f.workspace_directory_id, d.directory_name
           FROM files f LEFT JOIN workspace_directories d
             ON d.id=f.workspace_directory_id AND d.user_id=f.user_id AND d.deleted_at IS NULL
           WHERE f.id>$1 ORDER BY f.id LIMIT 250`, [cursor],
        )
        if (!rows.length) break
        const projectRoots = new Map<string, string | null>()
        for (const row of rows) {
          const area = row.deleted_at ? '回收站' : ({
            personal: '个人文件', project: '项目文件', workspace: '工作区', mind: '笔记和画布',
          } as Record<string, string>)[row.space] ?? '其他'
          const stats = groups.get(area) ?? {
            total: 0, inPlace: 0, needsPlacement: 0, missing: 0, unsafe: 0, sizeMismatch: 0, stageTag: 0,
          }
          groups.set(area, stats)
          stats.total++
          if (row.stage_name) stats.stageTag++
          const owner = normalizeFileOwnerId(row.user_id)
          if (!isOwnedFileStorageKey(owner, row.storage_key)) {
            stats.unsafe++
            await record(manifest, { kind: 'file', state: 'unsafe', legacy: row })
            continue
          }
          try {
            const opened = await openAnchoredLocalFile(config.storageLocalPath, row.storage_key)
            if (!opened) {
              stats.missing++
              await record(manifest, { kind: 'file', state: 'missing', legacy: row })
              continue
            }
            try {
              if (Number(row.size_bytes) !== opened.size) stats.sizeMismatch++
            } finally {
              await opened.handle.close()
            }
          } catch (error) {
            if (!(error instanceof UnsafeLocalPathError)) throw error
            stats.unsafe++
            await record(manifest, { kind: 'file', state: 'unsafe', legacy: row })
            continue
          }

          let root: string | null = null
          if (row.deleted_at) root = `${owner}/trash`
          else if (row.space === 'personal') root = personalFileStorageKey(owner)
          else if (row.space === 'workspace' && row.directory_name)
            root = workspaceDirectoryStorageKey(owner, row.directory_name)
          else if (row.space === 'project' && row.project_id !== null) {
            const key = `${owner}:${row.project_id}`
            if (!projectRoots.has(key)) {
              try {
                projectRoots.set(key, await readPostgresProjectPathMirrorKey(client, owner, row.project_id))
              } catch (error) {
                if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
                projectRoots.set(key, null)
              }
            }
            root = projectRoots.get(key) ?? null
          }
          const relativePath = root && row.storage_key.startsWith(`${root}/`) ? row.storage_key.slice(root.length + 1) : null
          const inPlace = relativePath !== null && !relativePath.split('/').some(part => part.startsWith('.gugu-'))
          const state = inPlace ? 'inPlace' : 'needsPlacement'
          stats[state]++
          let restoreKey: string | null = null
          let restoreTarget: { directory: FileDirectory; relativePath: string } | null = null
          if (manifest && row.deleted_at) {
            try {
              restoreKey = await originalStorageKey(client, owner, row)
              const directory = row.space === 'personal' ? 'personal'
                : row.space === 'project' && row.project_id !== null ? { projectId: row.project_id }
                : row.space === 'workspace' ? row.workspace_directory_id : null
              if (directory !== null) {
                const restoreRoot = await resolveFileDirectoryRoot(client, owner, directory)
                if (restoreKey.startsWith(`${restoreRoot}/`))
                  restoreTarget = { directory, relativePath: restoreKey.slice(restoreRoot.length + 1) }
              }
            }
            catch (error) {
              if (!(error instanceof CoreError) || !['conflict', 'invalid_request', 'not_found'].includes(error.code)) throw error
            }
          }
          await record(manifest, { kind: 'file', state, legacy: row, root, restoreKey, restoreTarget, relativePath: inPlace ? relativePath : null })
        }
        cursor = rows.at(-1)!.id
      }
      const { rows: [directories] } = await client.query(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
         FROM folders`,
      )
      const { rows: [bindings] } = await client.query(
        'SELECT count(*)::int AS folder_bindings FROM workspaces WHERE folder_id IS NOT NULL',
      )
      if (manifest) {
        let folderCursor = 0
        while (true) {
          const { rows } = await client.query<{ id: number }>(
            `SELECT id,user_id,name,project_id,workspace_directory_id,parent_id,deleted_at
             FROM folders WHERE id>$1 ORDER BY id LIMIT 250`, [folderCursor],
          )
          if (!rows.length) break
          for (const row of rows) await record(manifest, { kind: 'folder', legacy: row })
          folderCursor = rows.at(-1)!.id
        }
      }
      await client.query('ROLLBACK')
      return { files: Object.fromEntries(groups), directories, bindings }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

async function run(args: string[]) {
  if (!args.length) return inspect(null)
  if (args.length !== 2 || args[0] !== '--manifest' || !isAbsolute(args[1]))
    throw new Error('预检可接收一个用于保存清单的新绝对路径')
  const destination = args[1]
  const temp = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    let report
    try {
      report = await inspect(handle)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temp, destination)
    return report
  } finally {
    await unlink(temp)
  }
}

run(process.argv.slice(2)).then(report => {
  console.log(JSON.stringify(report, null, 2))
}).catch(() => {
  console.error('文件迁移预检失败。请确认数据库迁移状态、存储根可读性和 Linux 运行环境。')
  process.exitCode = 1
})
