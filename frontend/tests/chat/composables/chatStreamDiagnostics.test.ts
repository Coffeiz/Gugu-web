import { afterEach, expect, it } from 'vitest'
import { recordStreamDiagnostic } from '@/components/common/gugu-chat/composables/chatStreamDiagnostics'

afterEach(() => sessionStorage.clear())
it('诊断有界保存状态元数据并可在刷新后的存储中读取', () => {
  for (let sequence = 1; sequence <= 305; sequence++) {
    recordStreamDiagnostic({ session: 42, sequence, matched: true }, '工具终态匹配')
  }
  const rows = JSON.parse(sessionStorage.getItem('gugu-chat-stream-diagnostics')!)
  expect(rows).toHaveLength(300)
  expect(rows[0].sequence).toBe(6)
  expect(rows.at(-1)).toMatchObject({ session: 42, sequence: 305, matched: true })
  expect(Object.keys(rows[0]).sort()).toEqual(['matched', 'phase', 'sequence', 'session', 'time'])
})
