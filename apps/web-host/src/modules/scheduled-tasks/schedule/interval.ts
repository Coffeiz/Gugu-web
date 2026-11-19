/** APScheduler IntervalTrigger 的窗口及锚点规则；返回给定时间起的下一次触发。 */
export function nextIntervalFire(input: {
  intervalMinutes: number
  startAt: number
  endAt: number | null
  after: number
}): number | null {
  const { intervalMinutes, startAt, endAt, after } = input
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60 ||
      !Number.isFinite(startAt) || !Number.isFinite(after) || (endAt !== null && !Number.isFinite(endAt)))
    throw new RangeError('定时任务间隔或时间无效')
  const step = intervalMinutes * 60_000
  const count = Math.max(0, Math.ceil((after - startAt) / step))
  const next = startAt + count * step
  return endAt !== null && next > endAt ? null : next
}
