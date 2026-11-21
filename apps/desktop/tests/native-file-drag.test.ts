import { expect, it, vi } from 'vitest'
import { createNativeFileDragGuard } from '../src/preload/native-file-drag.js'

it('本窗口拖出的文件返回时不提示导入，也不拦截下一次外部导入', () => {
  const target = new EventTarget()
  const pathForFile = (file: File) => '/synthetic/' + file.name
  const mark = createNativeFileDragGuard(target, pathForFile)
  const onImport = vi.fn()
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'])
    target.addEventListener(type, onImport)
  function send(type: string, files: File[] = []) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      dataTransfer: { types: ['Files'], files },
    })
    return target.dispatchEvent(event)
  }

  const file = new File([], '合成.txt')
  const other = new File([], '外部.txt')
  mark(pathForFile(file))
  for (const type of ['dragenter', 'dragover', 'dragleave']) expect(send(type)).toBe(false)
  expect(send('drop', [file])).toBe(false)
  expect(onImport).not.toHaveBeenCalled()

  mark(pathForFile(file))
  expect(send('drop', [other])).toBe(true)
  expect(onImport).toHaveBeenCalledTimes(1)

  mark(pathForFile(file))
  target.dispatchEvent(Object.assign(new Event('pointermove'), { buttons: 0 }))
  expect(send('dragenter')).toBe(true)
  expect(send('drop', [file])).toBe(true)
  expect(onImport).toHaveBeenCalledTimes(3)
})
