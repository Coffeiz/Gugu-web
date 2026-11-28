/** 配置事件只传递失效信号，不跨窗口传递模型凭据。 */
export function notifyModelConfigChanged() {
  window.dispatchEvent(new Event('gugu-chat-models-changed'))
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('gugu-model-config')
    channel.postMessage('changed')
    channel.close()
  }
}

export function subscribeModelConfigChanged(refresh: () => void) {
  window.addEventListener('gugu-chat-models-changed', refresh)
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gugu-model-config') : undefined
  if (channel) channel.onmessage = event => { if (event.data === 'changed') refresh() }
  return () => {
    window.removeEventListener('gugu-chat-models-changed', refresh)
    channel?.close()
  }
}
