// 发版门：构建版本号变了（新版本上线）→ 清掉跨版本可能过期的客户端状态，
// 避免新代码读到旧 localStorage 走旧逻辑。**保留登录态 + 少数无害偏好**。
// __APP_VERSION__ 由 vite define 注入（git 短哈希，取不到则构建时间戳）；缺省回退 'dev'。
//
// ⚠️ 主站(/)和后台(/admin)同源、共享 localStorage：KEEP 必须同时含两边的登录 token，
// 否则先加载的那个 app 会把另一个的登录态清掉。两边同版本号 → 只第一个触发清理，不会互相打架。
const KEEP = [
  'user_token',        // 主站登录
  'admin_token',       // 后台登录
  'app_version',       // 版本门自身的标记
  'gugu_mini_pinned',  // 偏好：球钉住
  'gugu_audio_volume', // 偏好：音量
]

export function runClientVersionGate() {
  try {
    const cur = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
    if (localStorage.getItem('app_version') === cur) return   // 同版本，不动
    // 新版本：清掉 KEEP 之外的所有 localStorage + 整个 sessionStorage（会话级状态本就该重置）
    Object.keys(localStorage).forEach((k) => { if (!KEEP.includes(k)) localStorage.removeItem(k) })
    try { sessionStorage.clear() } catch { /* 忽略 */ }
    localStorage.setItem('app_version', cur)
  } catch {
    // localStorage 不可用（隐私模式等）：跳过，不影响应用启动
  }
}
