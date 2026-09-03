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

let lastBrandColor = ''
let rerenderTimer: ReturnType<typeof setTimeout> | undefined

function render() {
  const brand = `color:${brandColor()};font-weight:bold`
  lastBrandColor = brandColor()
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
 * 打印横幅并跟随主题变化重打。
 *
 * 主题初始化分两步：启动时读 localStorage，登录后服务端偏好（applyServerTheme）
 * 才把真正的 family/palette 应用上来——只打印一次会停在默认调色板的颜色上。
 * 这里监听 <html> 的主题属性，变化后防抖重打（服务端偏好落地、用户手动切主题
 * 都会触发）；颜色没变时跳过，避免无意义刷屏。
 */
export function startConsoleBanner() {
  render()
  const observer = new MutationObserver(() => {
    clearTimeout(rerenderTimer)
    rerenderTimer = setTimeout(() => {
      if (brandColor() !== lastBrandColor) render()
    }, 300)
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-family', 'data-palette'],
  })
}
