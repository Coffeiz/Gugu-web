import { posix } from 'node:path'

export interface BubblewrapMount {
  /** 源目录由可信 Host 授权并固定；不接受模型提供的宿主路径。 */
  source: string
  descriptor?: number
  target: string
  readonly: boolean
}

export interface BubblewrapLaunch {
  rootfs: string
  mounts: readonly BubblewrapMount[]
  cwd: string
  command: string
  interactive?: boolean
}

/** 把 Host 持有的目录描述符映射到执行器继承的描述符序号。 */
export function inheritBubblewrapMounts(mounts: readonly BubblewrapMount[], firstDescriptor: number) {
  const descriptors: number[] = []
  const inherited = mounts.map(mount => {
    if (mount.descriptor === undefined) return mount
    if (!Number.isSafeInteger(mount.descriptor) || mount.descriptor < 3) throw new Error('沙盒目录句柄无效')
    const descriptor = firstDescriptor + descriptors.length
    descriptors.push(mount.descriptor)
    return { ...mount, descriptor }
  })
  return { mounts: inherited, descriptors }
}

/** 只构建隔离参数；调用方仍须固定目录、复核权限并落实进程与资源限制。 */
export function bubblewrapArguments(request: BubblewrapLaunch): string[] {
  const absolute = (value: string) => typeof value === 'string' && value.startsWith('/')
    && !value.includes('\0') && posix.normalize(value) === value
  if (!absolute(request.rootfs) || request.rootfs === '/' || !absolute(request.cwd)
    || !request.command.trim() || request.command.includes('\0') || request.mounts.length === 0 || request.mounts.length > 64)
    throw new Error('沙盒启动参数无效')
  const targets = new Set<string>()
  for (const mount of request.mounts) {
    if (!absolute(mount.source) || !absolute(mount.target) || typeof mount.readonly !== 'boolean'
      || (mount.descriptor !== undefined && (!Number.isSafeInteger(mount.descriptor) || mount.descriptor < 3))
      || !['/workspace/', '/personal/', '/project/'].some(prefix => mount.target.startsWith(prefix))
        && !['/workspace', '/personal', '/project', '/skills'].includes(mount.target)
      || targets.has(mount.target)) throw new Error('沙盒挂载参数无效')
    targets.add(mount.target)
  }
  if (![...targets].some(target => request.cwd === target || request.cwd.startsWith(`${target}/`)))
    throw new Error('沙盒工作目录未授权')
  // 父挂载必须先于子挂载，才能让较窄的授权覆盖父目录权限。
  const mounts = [...request.mounts].sort((a, b) => a.target.length - b.target.length)
  // 独立运行根是只读的。没有整根挂载时，在私有 tmpfs 中创建动态工作区目标。
  const scaffolds = ['/workspace', '/personal', '/project'].filter(root =>
    !targets.has(root) && mounts.some(mount => mount.target.startsWith(`${root}/`)))
  return ['--unshare-all', '--die-with-parent', ...(request.interactive ? [] : ['--new-session']), '--ro-bind', request.rootfs, '/',
    '--unshare-user', '--disable-userns', '--unshare-net', '--cap-drop', 'ALL', '--hostname', 'gugu-sandbox',
    '--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp',
    ...scaffolds.flatMap(root => ['--size', '1048576', '--tmpfs', root]),
    ...mounts.flatMap(mount => mount.descriptor === undefined
      ? [mount.readonly ? '--ro-bind' : '--bind', mount.source, mount.target]
      : [mount.readonly ? '--ro-bind-fd' : '--bind-fd', String(mount.descriptor), mount.target]),
    ...scaffolds.flatMap(root => ['--remount-ro', root]),
    '--chdir', request.cwd, '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'HOME', '/tmp',
    ...(request.interactive ? ['--setenv', 'TERM', 'xterm-256color', '--setenv', 'PS1', 'gugu-sandbox:\\w\\$ ',
      '--', '/bin/bash', '--noprofile', '--norc', '-i']
      : ['--', '/bin/sh', '-c', request.command])]
}
