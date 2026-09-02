import { describe, expect, it } from 'vitest'
import { classifyLogLevel } from './logLevel'

describe('classifyLogLevel', () => {
  it('只按独立的 INFO 级别识别', () => {
    expect(classifyLogLevel('09-02 15:59:11 INFO [agent.context.branch] error_type=- error_status=-')).toBe('info')
  })

  it('不会把 error_type 或 exception 字段误判为错误', () => {
    expect(classifyLogLevel('09-02 15:59:11 INFO completed error_type=exception')).toBe('info')
    expect(classifyLogLevel('09-02 15:59:11 INFO completed traceback_count=0')).toBe('info')
  })

  it('保留真正的错误和警告级别', () => {
    expect(classifyLogLevel('web 09-02 15:59:11 ERROR request failed')).toBe('error')
    expect(classifyLogLevel('worker 09-02 15:59:11 WARNING retrying')).toBe('warning')
  })
})
