import {
  PhBrowser,
  PhCalendarBlank,
  PhCalendarDot,
  PhCheckCircle,
  PhClock,
  PhFolder,
  PhPlayCircle,
  PhStack,
  PhTrash,
  PhUser,
} from '@phosphor-icons/vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'

const STATUS_COLOR: Record<string, string> = { pending: '#8a8fa8', active: '#5080c8', done: '#4a9a72' }
const STATUS_ICON: Record<string, typeof PhClock> = { pending: PhClock, active: PhPlayCircle, done: PhCheckCircle }

/** 文件库伪文件夹的图标、强调色和卡片样式映射。 */
export function useFileLibraryFolderPresentation() {
  function folderIconStyle(folder: FolderCardMeta) {
    if (folder.type === 'personal') return { background: 'rgba(180,148,80,0.14)', color: '#b49450' }
    if (folder.type === 'projects') return { background: 'rgba(123,127,178,0.13)', color: '#7b7fb2' }
    if (folder.type === 'trash') return { background: 'rgba(220,80,80,0.1)', color: '#c85a5a' }
    if (folder.type === 'status') {
      const color = STATUS_COLOR[folder.status ?? ''] || '#7b7fb2'
      return { background: `${color}1f`, color }
    }
    if (folder.type === 'year') return { background: 'rgba(80,160,120,0.12)', color: '#4a9a72' }
    if (folder.type === 'month') return { background: 'rgba(80,130,200,0.11)', color: '#5080c8' }
    if (folder.color) return { background: `${folder.color}22`, color: folder.color }
    return { background: 'rgba(123,127,178,0.1)', color: 'var(--color-primary)' }
  }

  function folderListIcon(folder: FolderCardMeta) {
    if (folder.type === 'personal') return PhUser
    if (folder.type === 'projects') return PhStack
    if (folder.type === 'trash') return PhTrash
    if (folder.type === 'status') return STATUS_ICON[folder.status ?? ''] || PhStack
    if (folder.type === 'year') return PhCalendarBlank
    if (folder.type === 'month') return PhCalendarDot
    if (folder.type === 'project') return PhBrowser
    return PhFolder
  }

  function folderAccentColor(folder: FolderCardMeta) {
    if (folder.type === 'personal') return '#967858'
    if (folder.type === 'projects') return '#6878a8'
    if (folder.type === 'trash') return '#987070'
    if (folder.type === 'status') return STATUS_COLOR[folder.status ?? ''] || '#8888a8'
    if (folder.type === 'year') return '#508878'
    if (folder.type === 'month') return '#5878a8'
    if (folder.color) return folder.color
    return '#8888a8'
  }

  return { folderIconStyle, folderListIcon, folderAccentColor }
}
