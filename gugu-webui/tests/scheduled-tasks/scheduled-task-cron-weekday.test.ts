import assert from 'node:assert/strict'
import test from 'node:test'
import { crontabWeekdayToApscheduler } from '../../src/domains/scheduled-tasks/cron-weekday.js'

test('标准 crontab 的数字星期与名称映射到相同星期', () => {
  assert.deepEqual(
    ['0', '1', '2', '3', '4', '5', '6'].map(crontabWeekdayToApscheduler),
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  )
  assert.equal(crontabWeekdayToApscheduler('mon-fri'), 'mon,tue,wed,thu,fri')
})

test('星期范围、列表和步长保持 Python 定时器的触发日', () => {
  assert.equal(crontabWeekdayToApscheduler('1-5'), 'mon,tue,wed,thu,fri')
  assert.equal(crontabWeekdayToApscheduler('0,6'), 'sun,sat')
  assert.equal(crontabWeekdayToApscheduler('*/2'), 'sun,tue,thu,sat')
  assert.equal(crontabWeekdayToApscheduler('1-5/2'), 'mon,wed,fri')
})

test('同一星期的数字与名称不会在列表转换中重复', () => {
  assert.equal(crontabWeekdayToApscheduler('0,sun,7'), 'sun')
  assert.equal(crontabWeekdayToApscheduler('1,mon,3'), 'mon,wed')
})

test('不支持的扩展语法保留原项交由 CronTrigger 校验', () => {
  assert.equal(crontabWeekdayToApscheduler('1#2'), '1#2')
})
