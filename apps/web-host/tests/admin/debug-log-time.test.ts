import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { timestampConsole } from '../../src/shared/logging.js'

test('Node 控制台日志记录发生时间并保留格式化参数', () => {
  const stream = new PassThrough()
  let output = ''
  stream.on('data', chunk => { output += chunk.toString() })
  const logger = new Console({ stdout: stream, stderr: stream })
  timestampConsole(logger, () => new Date(2026, 10, 19, 13, 45, 7))
  logger.info('started %s', 'web')
  logger.error('failed %d', 2)
  assert.equal(output, '11-19 13:45:07 started web\n11-19 13:45:07 failed 2\n')
})

test('Node 控制台多行日志的每一行都有时间戳', () => {
  const stream = new PassThrough()
  let output = ''
  stream.on('data', chunk => { output += chunk.toString() })
  const logger = new Console({ stdout: stream, stderr: stream })
  timestampConsole(logger, () => new Date(2026, 10, 19, 13, 45, 7))
  logger.info('first line\nsecond line')
  assert.equal(output, '11-19 13:45:07 first line\n11-19 13:45:07 second line\n')
})
