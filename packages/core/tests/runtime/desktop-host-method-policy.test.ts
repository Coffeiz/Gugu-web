import { expect, it } from 'vitest'
import { isAllowedDesktopAgentHostRequest } from '../../src/runtime/desktop-host-method-policy.js'

it('仅放行桌面 Agent 明确声明的宿主请求', () => {
  for (const method of [
    'agent.email.accounts',
    'agent.email.attachments',
    'agent.email.send',
    'agent.tools.policy',
    'agent.files.resolveDroppedReference',
    'agent.files.saveAttachment',
    'agent.im.sendAttachment',
  ]) expect(isAllowedDesktopAgentHostRequest(method)).toBe(true)

  for (const method of ['agent.email.delete', 'agent.email.send.raw', 'agent.sessions.delete', 'agent.files'])
    expect(isAllowedDesktopAgentHostRequest(method)).toBe(false)
})
