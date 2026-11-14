/** 执行提交后副作用；工作或诊断失败都不会改变已完成的主操作结果。 */
export async function runBestEffort(
  operation: string,
  work: () => Promise<unknown>,
  reportFailure: (operation: string, errorCode?: string, errorMessage?: string) => void,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    try {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : undefined
      reportFailure(operation, code, error instanceof Error ? error.message : undefined)
    } catch {
      // 诊断失败不能改变已完成的主操作结果。
    }
  }
}
