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
  expect(describeShellActivity({ command: 'rg synthetic src | unknown' })).toBeUndefined()
  expect(describeShellActivity({ command: "grep 'synthetic-'token" })).toBeUndefined()
  expect(describeShellActivity({ command: 'cat ./secrets.txt' })).toEqual({ action: 'read' })
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
