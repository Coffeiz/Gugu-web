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

export function printConsoleBanner() {
  const brand = 'color:#7b7fb2;font-weight:bold'
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
