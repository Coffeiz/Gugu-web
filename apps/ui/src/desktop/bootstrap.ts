function showBootFailure() {
  const root = document.querySelector('#app')
  if (!root?.querySelector('.desktop-boot-shell')) return
  const panel = document.createElement('div')
  panel.className = 'desktop-boot-shell'
  const content = document.createElement('div')
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = '咕咕启动未完成，请重试。'
  const retry = document.createElement('button')
  retry.textContent = '重新加载'
  retry.addEventListener('click', () => location.reload())
  content.append(message, retry)
  panel.append(content)
  root.replaceChildren(panel)
}

const timeout = window.setTimeout(showBootFailure, 20_000)
void import('./main').then(({ mountDesktop }) => mountDesktop())
  .catch(showBootFailure)
  .finally(() => window.clearTimeout(timeout))
