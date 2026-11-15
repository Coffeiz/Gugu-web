import { CoreError, dataContext } from '../contracts/index.js'

export class ScheduledTaskNotFound extends Error {}
export interface ScheduledTaskDeleteRuntime {
  /** 返回值仅在删除事务已提交后交给用例；不得在事务中发布事件。 */
  deleteOwned(ownerId: string, id: number): Promise<boolean>
  publish(ownerId: string, id: number, origin: string | null): Promise<void>
}
/** 删除持久记录，不承诺取消已经启动的执行。 */
export function createScheduledTaskDeleter(runtime: ScheduledTaskDeleteRuntime) {
  return async (rawOwner: string, id: number, origin: string | null): Promise<void> => {
    const owner = dataContext(rawOwner).ownerId
    if (!Number.isSafeInteger(id)) throw new CoreError('invalid_request', '任务标识无效')
    if (!(await runtime.deleteOwned(owner, id))) throw new ScheduledTaskNotFound('任务不存在')
    await runtime.publish(owner, id, origin)
  }
}
