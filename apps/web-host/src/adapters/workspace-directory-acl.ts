import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'

const execFileAsync = promisify(execFile)
const sandboxId = 65_532

interface RuntimeIdentity {
  schema: 1
  daemon_mode: 'rootful' | 'rootless'
  container_uid: 65_532
  container_gid: 65_532
  mapped_uid: number
  mapped_gid: number
}

function mappedId(text: string, login: string): number | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const parts = rawLine.trim().split(':')
    if (parts.length !== 3 || parts[0] !== login) continue
    const start = Number(parts[1])
    const count = Number(parts[2])
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && count >= sandboxId)
      return start + sandboxId - 1
  }
  return null
}

async function sandboxGroupId(login: string): Promise<number | null> {
  try {
    const identity = JSON.parse(await readFile('/run/gugu/sandbox-storage-identity.json', 'utf8')) as Partial<RuntimeIdentity>
    if (identity.schema === 1 && (identity.daemon_mode === 'rootful' || identity.daemon_mode === 'rootless')
      && identity.container_uid === sandboxId && identity.container_gid === sandboxId
      && Number.isSafeInteger(identity.mapped_gid) && Number(identity.mapped_gid) >= 0) {
      return identity.mapped_gid!
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  try {
    return mappedId(await readFile('/etc/subgid', 'utf8'), login)
  } catch {
    return null
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
}

/** 与 Python workspace ACL 保持一致；rootless 映射不可用时退回兼容 chmod。 */
export async function prepareWorkspaceDirectoryAcl(directoryPath: string): Promise<void> {
  if (!directoryPath.startsWith('/') || directoryPath === '/')
    throw new Error('Workspace 路径必须是非根绝对路径')
  await mkdir(directoryPath, { recursive: true, mode: 0o777 })
  const login = userInfo().username
  const gid = await sandboxGroupId(login)
  if (gid === null) {
    await chmod(directoryPath, 0o777)
    return
  }

  try {
    await run('chmod', ['0770', directoryPath])
    await run('setfacl', ['-m', `u:${login}:rwx,g:${gid}:rwx`, directoryPath])
    await run('setfacl', ['-d', '-m', `u::rwx,u:${login}:rwx,g::rwx,g:${gid}:rwx,m::rwx`, directoryPath])
    await run('find', [directoryPath, '-type', 'f', '-user', login, '-exec', 'setfacl', '-m', `u:${login}:rwX,g:${gid}:rwX`, '{}', '+'])
    await run('find', [directoryPath, '-type', 'd', '-user', login, '-exec', 'setfacl', '-m', `u:${login}:rwx,g:${gid}:rwx,m::rwx,d:u:${login}:rwx,d:g:${gid}:rwx,d:m::rwx`, '{}', '+'])
  } catch {
    await chmod(directoryPath, 0o777)
  }
}
