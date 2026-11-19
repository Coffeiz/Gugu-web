import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runBubblewrapCommand } from '@gugu/sandbox/linux/command'
import { createBubblewrapPtyBridge } from '@gugu/sandbox/linux/pty'

const marker = 'gugu-bubblewrap-rootfs-v1'

export function resolveBubblewrapRootfs(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.GUGU_BUBBLEWRAP_ROOTFS
  return configured === undefined
    ? (process.platform === 'linux' ? '/var/lib/gugu-sandbox/rootfs' : undefined)
    : configured.trim() || undefined
}

async function trustedRootfs(root: string) {
  if (!root.startsWith('/') || root === '/' || resolve(root) !== root) return false
  for (let entry = root; entry !== '/'; entry = dirname(entry)) {
    const info = await lstat(entry)
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false
  }
  const [release, hostname, resolver, hosts, machineId] = await Promise.all(
    ['gugu-sandbox-release', 'hostname', 'resolv.conf', 'hosts', 'machine-id']
      .map(file => readFile(join(root, 'etc', file), 'utf8')),
  )
  return release?.trim() === marker && hostname === 'gugu-sandbox\n'
    && resolver === '# Gugu sandbox has no DNS\n' && hosts === '127.0.0.1 localhost\n::1 localhost\n' && machineId === ''
}

async function probeRootfs(rootfs: string) {
  if (!await trustedRootfs(rootfs)) return false
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-bwrap-check-'))
  try {
    const directory = await open(scratch, 'r')
    try {
      const mounts = [{ source: scratch, descriptor: directory.fd, target: '/workspace', readonly: false }]
      const result = await runBubblewrapCommand({ rootfs, mounts, cwd: '/workspace',
        command: 'test "$PWD" = /workspace && test -f /etc/gugu-sandbox-release && test ! -e /proc/self/fd/3 && echo ready',
      }, { timeoutMs: 3000, outputBytes: 1024, resourceScope: true })
      if (!result.ok || result.stdout.trim() !== 'ready') return false
      const pty = await createBubblewrapPtyBridge(rootfs).open({
        terminalId: randomUUID(), sandboxCwd: '/workspace', sandboxMounts: mounts,
        cols: 80, rows: 24, networkProfile: 'none', timeoutMs: 3000,
      })
      try {
        // 两段在命令回显中分离，只有实际执行后的输出才含完整标记。
        const token = randomUUID()
        await pty.write(Buffer.from(`printf '%s%s\\n' '${token.slice(0, 18)}' '${token.slice(18)}'\n`))
        let output = ''
        for await (const chunk of pty.output()) {
          output = (output + Buffer.from(chunk).toString('utf8')).slice(-4096)
          if (output.includes(token)) return true
        }
        return false
      } finally { await pty.close() }
    } finally { await directory.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export async function isolatedShellReadiness(rootfs?: string) {
  const supported = Boolean(rootfs && process.platform === 'linux' && process.getuid?.() !== 0
    && await probeRootfs(rootfs).catch(() => false))
  return { executionBackend: 'bubblewrap' as const, supported, checkAvailable: Boolean(rootfs), methods: supported ? ['bubblewrap'] : [],
    proxyEnforcement: false, proxyEnforcementReason: '当前 Bubblewrap 后端仅支持断网执行',
    ...(supported ? {} : { reason: '独立文件系统沙盒未就绪，请检查运行环境、Bubblewrap、AppArmor 和 systemd 用户服务' }),
  }
}

/** 合并并发检查，运行配置变化仍由调用方实时复核。 */
export function createIsolatedShellReadiness(rootfs?: string) {
  let pending: ReturnType<typeof isolatedShellReadiness> | undefined
  let checkedAt = 0
  return () => {
    if (!pending || (checkedAt !== 0 && Date.now() - checkedAt >= 30_000)) {
      checkedAt = 0
      pending = isolatedShellReadiness(rootfs).finally(() => { checkedAt = Date.now() })
    }
    return pending
  }
}
