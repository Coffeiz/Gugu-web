export class WatcherCapacityUnavailable extends Error {
 constructor(){super('宿主机 watcher 管理服务不可用')}
}
export class WatcherCapacityAtLimit extends Error {
 constructor(){super('当前容量已达到配置硬上限')}
}
/** 固定按一档扩容；目标硬上限、当前使用量和并发锁由正式helper决定。 */
export function createWatcherCapacityExpander(request:()=>Promise<Record<string,unknown>>) {
 return async()=>{
  const result=await request()
  if(!result.expanded)throw new WatcherCapacityAtLimit()
  return result
 }
}
