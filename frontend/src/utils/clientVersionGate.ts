// 发版门：构建版本号变了（新版本上线）→ 清掉跨版本可能过期的客户端状态。
// __APP_VERSION__ 由 vite define 注入（git 短哈希，取不到则构建时间戳）；缺省回退 'dev'。
//
const KEEP = [
  'app_version',       // 版本门自身的标记
  'gugu_mini_pinned',  // 偏好：球钉住
  'gugu_audio_volume', // 偏好：音量
  'gugu_video_volume', // 偏好：视频音量
  'gugu-document-font-size', // 偏好：文档预览字号
]

export function runClientVersionGate() {
  try {
    // 旧版本曾在 localStorage 留下可读 Bearer JWT；升级后立即清掉。
    localStorage.removeItem('user_token')
    localStorage.removeItem('admin_token')
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
