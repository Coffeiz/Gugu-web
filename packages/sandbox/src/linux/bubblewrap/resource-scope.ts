/** systemd 在启动子进程前将其加入带资源上限的 cgroup v2 scope。 */
export function bubblewrapResourceScope(binary: string, args: readonly string[], enabled: boolean) {
  const env: NodeJS.ProcessEnv = { LANG: 'C' }
  if (!enabled) return { binary, args, env }
  const uid = process.getuid?.()
  if (uid === undefined || uid === 0) throw new Error('资源隔离需要非 root Linux 执行环境')
  const runtime = `/run/user/${uid}`
  env.XDG_RUNTIME_DIR = runtime
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`
  return {
    binary: '/usr/bin/systemd-run',
    args: ['--user', '--scope', '--quiet', '-p', 'TasksMax=64', '-p', 'MemoryMax=268435456',
      '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=100%', '--', binary, ...args],
    env,
  }
}
