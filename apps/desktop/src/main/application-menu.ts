import { app, BrowserWindow, dialog, shell, type MenuItemConstructorOptions } from 'electron'
import type { ApplicationEditAction, ApplicationMenuCommand } from '@gugu/desktop-contracts'
import { dispatchWindowEdit } from './windows.js'

type MenuOptions = {
  mac: boolean
  canUpdate: boolean
  checkForUpdates: () => Promise<void>
  sendCommand: (command: ApplicationMenuCommand) => void
}

const separator = { type: 'separator' } as const
const editItems: Array<{ action: ApplicationEditAction; label: string; accelerator: string }> = [
  { action: 'undo', label: '撤销', accelerator: 'Command+Z' },
  { action: 'redo', label: '重做', accelerator: 'Command+Shift+Z' },
  { action: 'cut', label: '剪切', accelerator: 'Command+X' },
  { action: 'copy', label: '复制', accelerator: 'Command+C' },
  { action: 'paste', label: '粘贴', accelerator: 'Command+V' },
  { action: 'selectAll', label: '全选', accelerator: 'Command+A' },
]

function editItem(item: typeof editItems[number], mac: boolean): MenuItemConstructorOptions {
  if (!mac) return { role: item.action }
  return {
    label: item.label,
    accelerator: item.accelerator,
    click: (_item, window) => {
      if (window instanceof BrowserWindow) dispatchWindowEdit(window.webContents, item.action)
    },
  }
}

async function openHelp(url: string) {
  try {
    await shell.openExternal(url)
  } catch {
    await dialog.showMessageBox({ type: 'error', message: '无法打开链接' })
  }
}

export function buildApplicationMenu({ mac, canUpdate, checkForUpdates, sendCommand }: MenuOptions): MenuItemConstructorOptions[] {
  function command(label: string, action: ApplicationMenuCommand, accelerator?: string): MenuItemConstructorOptions {
    return { label, accelerator, click: () => sendCommand(action) }
  }

  const update = { label: '检查更新', enabled: canUpdate, click: checkForUpdates }
  const quit = { label: mac ? '退出咕咕' : '退出', role: 'quit' } as const
  const editing = editItems.map(item => editItem(item, mac))
  editing.splice(2, 0, separator)
  const edit = { label: '编辑', submenu: editing }
  if (!mac) return [{ label: '咕咕', submenu: [update, separator, quit] }, edit]
  return [
    {
      label: '咕咕',
      submenu: [
        { role: 'about', label: '关于咕咕' }, update,
        command('设置…', 'settings', 'Command+,'), separator,
        { role: 'hide', label: '隐藏咕咕' }, separator, quit,
      ],
    },
    {
      label: '文件',
      submenu: [
        command('新建项目', 'new-project', 'Command+N'),
        command('新建笔记', 'new-note', 'Command+Shift+N'),
        separator, { role: 'close', label: '关闭当前窗口' },
      ],
    },
    edit,
    {
      label: '前往',
      submenu: [
        command('全局搜索', 'search', 'Command+K'), separator,
        command('项目', 'projects'), command('日历', 'calendar'),
        command('笔记', 'notes'), command('画布', 'canvases'), command('文件库', 'files'),
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'togglefullscreen', label: '切换全屏' },
        separator, { role: 'front', label: '全部置于顶层' }, separator, { role: 'window' },
      ],
    },
    {
      label: '帮助', role: 'help',
      submenu: [
        {
          label: '快捷键速查',
          click: () => dialog.showMessageBox({
            title: '快捷键速查',
            message: '咕咕快捷键',
            detail: [
              '设置 ⌘,　　全局搜索 ⌘K',
              '新建项目 ⌘N　　新建笔记 ⌘⇧N',
              '撤销 ⌘Z　　重做 ⌘⇧Z',
              '剪切 ⌘X　　复制 ⌘C　　粘贴 ⌘V　　全选 ⌘A',
              '⌘ 点击逐项选择　　⇧ 点击选择范围',
              '关闭窗口 ⌘W　　最小化 ⌘M　　隐藏 ⌘H　　退出 ⌘Q',
            ].join('\n'),
          }),
        },
        { label: '使用文档', click: () => openHelp('https://github.com/Coffeiz/Gugu-web#readme') },
        { label: '问题反馈', click: () => openHelp('https://github.com/Coffeiz/Gugu-web/issues') },
      ],
    },
  ]
}

export function buildStatusMenu(mac: boolean, openWindow: () => void, newNote: () => void): MenuItemConstructorOptions[] {
  return [
    { label: '打开咕咕', click: openWindow },
    ...(mac ? [{ label: '快速记笔记', click: newNote }, separator] : []),
    { label: '退出咕咕', click: () => app.quit() },
  ]
}
