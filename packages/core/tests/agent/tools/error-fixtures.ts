/** Python统一业务错误契约的期望值，不调用生产投影函数生成断言。 */
export function expectedBusinessError(tool: string, error: string, extra: Record<string, unknown> = {}) {
  return { error, ...extra, tool,
    usage_hint: '工具执行失败。先根据错误信息判断下一步；需要用户补充信息时先询问，不要重复提交相同参数。',
    next_action: '根据错误信息修正或向用户询问缺失信息；确认没有新信息前不要盲目重试。',
  }
}
