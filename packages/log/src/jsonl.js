import { eventMessage } from './presentation.js'

/** 日志出口异常不改变业务运行结果。 */
export function writeLogRecord(sink, record) {
  try {
    const { time: suppliedTime, ...fields } = record ?? {}
    const parsedTime = typeof suppliedTime === 'string' ? Date.parse(suppliedTime) : NaN
    const time = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString()
    const message = eventMessage(fields)
    sink(JSON.stringify({ time, ...fields, ...(message ? { message } : {}) }) + '\n')
  }
  catch { /* 日志不可写时继续执行原流程。 */ }
}
