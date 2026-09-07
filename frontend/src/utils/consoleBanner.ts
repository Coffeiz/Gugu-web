// DevTools 控制台横幅：graffiti 描边字 + 版本信息。
// 版本号来自 vite define 注入（__APP_RELEASE__ = package.json 语义化版本，
// __APP_VERSION__ = git 短哈希，__RUNTIME_VERSION__ = runtime 包版本）。
const ART = [
  '  ________ ____ ___  ________ ____ ___',
  ' /  _____/|    |   \\/  _____/|    |   \\',
  '/   \\  ___|    |   /   \\  ___|    |   /',
  '\\    \\_\\  \\    |  /\\    \\_\\  \\    |  /',
  ' \\______  /______/  \\______  /______/',
  '        \\/                 \\/',
].join('\n')

// %c 不解析 var(--token)，打印时从当前主题读令牌值
function brandColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--action-primary').trim()
    || '#7b7fb2'
}

let hasRendered = false
let rerenderTimer: ReturnType<typeof setTimeout> | undefined

function scheduleRender() {
  clearTimeout(rerenderTimer)
  rerenderTimer = setTimeout(() => {
    render()
  }, 600)
}

function render() {
  if (hasRendered) return
  hasRendered = true
  const brand = `color:${brandColor()};font-weight:bold`
  console.info('%c' + ART, brand)
  const isDev = import.meta.env.DEV
  const runtime = __RUNTIME_VERSION__ || 'unknown'
  const status = isDev ? '● dev' : '● ready'
  const statusColor = isDev ? 'color:#d0a03f;font-weight:bold' : 'color:#3fbf7f;font-weight:bold'
  console.info(
    `%cgugu v${__APP_RELEASE__}%c · %cruntime v${runtime}%c · %c${status}`,
    brand, '', 'color:#888', '', statusColor,
  )
  console.info(
    `%c built ${__APP_BUILT_AT__} · commit ${__APP_VERSION__}`,
    'color:#888',
  )
}

/**
 * 打印一次控制台横幅。
 *
 * 启动时保留短暂防抖，给服务端偏好（applyServerTheme）落地的机会；横幅是诊断信息，
 * 不应跟随用户主题切换重复写入 DevTools。浏览器控制台只能追加日志，无法原地更新。
 */
export function startConsoleBanner() {
  scheduleRender()
}
