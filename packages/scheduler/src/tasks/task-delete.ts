export class ScheduledTaskNotFound extends Error {}
export interface ScheduledTaskDeleteRuntime {
  /** 用可信身份构建持久化查询的 owner，并校验任务标识。 */
  resolveOwner(rawOwner: string, id: number): string
  /** 返回值仅在删除事务已提交后交给用例；不得在事务中发布事件。 */
  deleteOwned(ownerId: string, id: number): Promise<boolean>
  publish(ownerId: string, id: number, origin: string | null): Promise<void>
}
/** 删除持久记录，不承诺取消已经启动的执行。 */
export function createScheduledTaskDeleter(runtime: ScheduledTaskDeleteRuntime) {
  return async (rawOwner: string, id: number, origin: string | null): Promise<void> => {
    const owner = runtime.resolveOwner(rawOwner, id)
    if (!(await runtime.deleteOwned(owner, id))) throw new ScheduledTaskNotFound('任务不存在')
    await runtime.publish(owner, id, origin)
  }
}
