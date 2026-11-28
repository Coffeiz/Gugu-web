/** 原生拖出重新进入窗口时，阻止其触发文件库和聊天的导入界面。 */
export function createNativeFileDragGuard(target: EventTarget, pathForFile: (file: File) => string) {
  let source: string | null = null
  const clear = () => { source = null }

  function block(event: Event) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onDrag(event: Event) {
    const data = (event as DragEvent).dataTransfer
    if (source && data?.types.includes('Files')) block(event)
  }

  function onDrop(event: Event) {
    const data = (event as DragEvent).dataTransfer
    const file = data?.files.length === 1 ? data.files[0] : undefined
    const fromThisWindow = Boolean(source && file && pathForFile(file) === source)
    clear()
    // 即使系统没有回传 dragend，不同路径的外部文件仍可正常导入。
    if (fromThisWindow) block(event)
  }

  for (const type of ['dragenter', 'dragover', 'dragleave'])
    target.addEventListener(type, onDrag, true)
  target.addEventListener('drop', onDrop, true)
  target.addEventListener('dragend', clear, true)
  target.addEventListener('pointerdown', clear, true)
  target.addEventListener('pointerup', clear, true)
  target.addEventListener('pointermove', event => {
    if ((event as PointerEvent).buttons === 0) clear()
  }, true)
  return (path: string | null) => { source = path }
}
