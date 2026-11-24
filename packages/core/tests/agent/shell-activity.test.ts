import { expect, it } from 'vitest'
import { describeShellActivity } from '../../src/agent/shell-activity.js'
import { projectAgentTimelineEvents } from '../../src/agent/sessions/message-projection.js'

const miss = { ok: false, exit_code: 1, timed_out: false, stdout: '', stderr: '' }

it('识别简单命令和管道，只投影可展示的目标名称', () => {
  expect(describeShellActivity({ command: 'cat "/home/synthetic/package.json" | grep "version"' }))
    .toEqual({ action: 'search', target: 'package.json' })
  expect(describeShellActivity({ command: 'rg synthetic-token src' })).toEqual({ action: 'search', target: 'src' })
  expect(describeShellActivity({ command: 'test -f tsconfig.json && cat package.json' })).toEqual({ action: 'checks' })
  expect(describeShellActivity({ command: 'rg --files src' })).toEqual({ action: 'find', target: 'src' })
  expect(describeShellActivity({ command: 'rg -n synthetic apps | head -20' })).toEqual({ action: 'search', target: 'apps' })
  expect(describeShellActivity({ command: "sed -n '20,40p' src/index.ts" })).toEqual({ action: 'read', target: 'index.ts' })
  expect(describeShellActivity({ command: 'git diff -- src | head' })).toEqual({ action: 'git_diff' })
  expect(describeShellActivity({ command: 'git log -5' })).toEqual({ action: 'git_history' })
  expect(describeShellActivity({ command: 'corepack pnpm --filter gugu-web test' })).toEqual({ action: 'test' })
  expect(describeShellActivity({ command: 'rg synthetic src | unknown' }))
    .toEqual({ action: 'commands', commandCount: 2, commands: ['rg', 'unknown'] })
  expect(describeShellActivity({ command: "grep 'synthetic-'token" })).toBeUndefined()
  expect(describeShellActivity({ command: 'cat ./secrets.txt' })).toEqual({ action: 'read' })
})

it('区分 echo 的文字与后续单独执行的命令', () => {
  expect(describeShellActivity({ command: 'echo "ls; cat package.json"' })).toBeUndefined()
  expect(describeShellActivity({ command: 'echo "目录（预览）" && ls src' })).toEqual({ action: 'directory', target: 'src' })
  expect(describeShellActivity({ command: "echo '目录; ls'\n\nls src" })).toEqual({ action: 'directory', target: 'src' })
  expect(describeShellActivity({ command: 'echo ok > output.txt\nls src' })).toBeUndefined()
})

it('识别 cd 和 echo 后的实际命令及管道', () => {
  expect(describeShellActivity({ command: 'cd "项目 #1" && corepack pnpm test' })).toEqual({ action: 'test' })
  expect(describeShellActivity({ command: 'cd src && echo "预览" && git diff | head' })).toEqual({ action: 'git_diff' })
  expect(describeShellActivity({ command: 'echo "预览" && cat package.json | grep version' }))
    .toEqual({ action: 'search', target: 'package.json' })
  expect(describeShellActivity({ command: 'cd src && rg version package.json' }, miss))
    .toEqual({ action: 'search', target: 'package.json' })
})

it('只有可以归因的搜索退出码才显示未找到匹配，历史摘要保留动作而隐藏详情', () => {
  expect(describeShellActivity({ command: 'grep version package.json' }, miss))
    .toEqual({ action: 'search', target: 'package.json', noMatches: true })
  expect(describeShellActivity({ command: 'cat package.json | grep version' }, miss))
    .toEqual({ action: 'search', target: 'package.json' })
  expect(describeShellActivity({ command: 'rg version src' }, { ...miss, timed_out: true }))
    .toEqual({ action: 'search', target: 'src' })
  const [event] = projectAgentTimelineEvents([{ id: 1, displayTimeline: [
    { kind: 'tool', toolName: 'shell', toolInput: { command: 'rg synthetic-token src' }, toolResult: miss },
  ] }])
  expect(event).toMatchObject({ shellActivity: { action: 'search', target: 'src', noMatches: true }, detailsAvailable: true })
  expect(event).not.toHaveProperty('toolInput')
  expect(event).not.toHaveProperty('toolResult')
})

it('单条未匹配的命令只展示可执行文件名，保留已识别动作和复杂命令的处理', () => {
  expect(describeShellActivity({ command: 'ffmpeg -i input.mov output.mp4' }))
    .toEqual({ action: 'command', target: 'ffmpeg' })
  expect(describeShellActivity({ command: 'cd src && /usr/bin/rsync file destination' }))
    .toEqual({ action: 'command', target: 'rsync' })
  expect(describeShellActivity({ command: '/usr/bin/git diff' })).toEqual({ action: 'git_diff' })
  for (const command of ['"$TOOL" arg', 'bash -c "date"', './private.sh'])
    expect(describeShellActivity({ command })).toBeUndefined()
})

it('目录检查的限流管道、状态分支和标准错误合并保留动作标题', () => {
  const command = 'ls -la "/tmp/demo folder/" | head -20; echo "---"; test -e "/tmp/demo folder/check" && echo "EXISTS" || echo "GONE"; ls -la /tmp/check 2>&1'
  expect(describeShellActivity({ command })).toEqual({ action: 'checks' })
  expect(describeShellActivity({ command: 'ls -la /tmp/demo 2>&1' })).toEqual({ action: 'directory', target: 'demo' })
  expect(describeShellActivity({ command: 'ls /tmp/demo > /tmp/output' })).toBeUndefined()
})

it('对复合诊断忽略分隔输出和限流器，只统计实际检查命令', () => {
  expect(describeShellActivity({ command: 'echo "=== date ==="; date; echo; whoami; pwd; uname -a; sw_vers' }))
    .toEqual({ action: 'system', commandCount: 5 })
  expect(describeShellActivity({ command: 'uptime; sysctl -n hw.ncpu hw.memsize 2>&1; ps -eo pid,pcpu,pmem,comm -r | head -6' }))
    .toEqual({ action: 'load_processes', commandCount: 3 })
  expect(describeShellActivity({ command: 'df -h | head -12; vm_stat | head -8; ps -eo pid,pmem,rss,comm -m | head -6' }))
    .toEqual({ action: 'resources', commandCount: 3 })
  expect(describeShellActivity({ command: 'pwd' })).toEqual({ action: 'cwd' })
  expect(describeShellActivity({ command: 'ffmpeg -i /tmp/input | wc' })).toEqual({ action: 'command', target: 'ffmpeg' })
  expect(describeShellActivity({ command: 'date | head /tmp/other-file' }))
    .toEqual({ action: 'commands', commandCount: 2, commands: ['date', 'head'] })
  expect(describeShellActivity({ command: 'date; "$DYNAMIC" arg' })).toBeUndefined()
})
