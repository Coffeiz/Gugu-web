import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { chatFabChannels as channels, type ChatFabGesture } from '../chat-fab-channels.js'

window.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('drop', event => {
  if (!event.isTrusted || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  const paths = Array.from(event.dataTransfer.files).slice(0, 50)
    .map(file => webUtils.getPathForFile(file)).filter(Boolean)
  if (paths.length) ipcRenderer.send(channels.dropFiles, paths)
})

contextBridge.exposeInMainWorld('guguChatFab', {
  onMaterial(listener: (glass: boolean) => void) {
    const receive = (_event: unknown, glass: boolean) => listener(glass)
    ipcRenderer.on(channels.material, receive)
    return () => ipcRenderer.removeListener(channels.material, receive)
  },
  gesture: (gesture: ChatFabGesture, x?: number, y?: number) => ipcRenderer.send(channels.gesture, gesture, x, y),
})
