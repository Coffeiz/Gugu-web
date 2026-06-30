/**
 * 并发限流器：控制同时在途的异步任务数。
 *
 * 批量上传 / 缩略图加载若不限流，会瞬间打满浏览器单域名连接（HTTP/1.1 约 6 条）
 * 和服务器带宽，导致尾部请求超时（503 / 网络错误）。用它把在途数量压在阈值内：
 *
 *   const limit = pLimit(3)
 *   await Promise.allSettled(items.map(it => limit(() => doAsync(it))))
 *
 * 任务排队、按阈值放行；某个完成（成功或失败）即补位下一个。
 */
export function pLimit(max) {
  let active = 0
  const queue = []
  const drain = () => {
    while (active < max && queue.length) {
      active++
      const { fn, resolve, reject } = queue.shift()
      Promise.resolve()
        .then(fn)                                   // 即便 fn 同步抛错也被捕获
        .then(resolve, reject)
        .finally(() => { active--; drain() })
    }
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      drain()
    })
}

// ── 全局并发阈值（集中调参，低配服务器/带宽吃紧时往小调）──────────────
export const UPLOAD_CONCURRENCY = 3   // 同时上传的文件数
export const THUMB_CONCURRENCY  = 6   // 同时加载的缩略图数（贴浏览器单域名连接上限）
