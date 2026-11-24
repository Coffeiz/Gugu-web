import { app, BrowserWindow, dialog } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { createNativeFileDialogs } from '../src/main/native-file-dialogs.js'

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}))

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

it('在 macOS 前台打开独立面板，取消后可以再次选择', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
  const dialogs = createNativeFileDialogs(() => undefined)
  const options = { filters: [{ name: 'ZIP', extensions: ['zip'] }] }
  const selection = Promise.withResolvers<Electron.OpenDialogReturnValue>()
  vi.mocked(dialog.showOpenDialog).mockReturnValueOnce(selection.promise)

  const pending = dialogs.open(options)
  expect(app.focus).toHaveBeenCalledWith({ steal: true })
  expect(dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(options)
  await expect(dialogs.save({})).rejects.toMatchObject({ code: 'conflict' })
  expect(dialog.showSaveDialog).not.toHaveBeenCalled()

  selection.resolve({ canceled: true, filePaths: [] })
  await expect(pending).resolves.toMatchObject({ canceled: true })
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' })
  await expect(dialogs.save({})).resolves.toMatchObject({ canceled: true })
})

it('只把面板挂到可见窗口，系统调用失败后允许重试', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: vi.fn(() => false) } as unknown as BrowserWindow
  vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(window)
  const dialogs = createNativeFileDialogs(() => undefined)
  const options = { defaultPath: 'archive.zip' }
  vi.mocked(dialog.showSaveDialog).mockRejectedValueOnce(new Error('系统调用失败'))

  await expect(dialogs.save(options)).rejects.toThrow('系统调用失败')
  expect(dialog.showSaveDialog).toHaveBeenNthCalledWith(1, window, options)
  vi.mocked(window.isMinimized).mockReturnValue(true)
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' })
  await expect(dialogs.save(options)).resolves.toMatchObject({ canceled: true })
  expect(dialog.showSaveDialog).toHaveBeenNthCalledWith(2, options)
})
