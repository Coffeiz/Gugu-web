import { describe, expect, it } from 'vitest'
import { desktopAgentToolPolicy } from '../src/main/agent/tool-policy.js'

describe('desktop Agent 工具策略', () => {
  it('将本地文件回收站工具交给桌面 Shell 处理', () => {
    expect(desktopAgentToolPolicy()).toEqual({ disabledTools: [
      'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
    ] })
  })
})
