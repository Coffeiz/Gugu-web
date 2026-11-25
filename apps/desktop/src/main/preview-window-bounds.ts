import type { DesktopPreviewMetadata } from '@gugu/desktop-contracts'
import { isTextExt } from '@gugu/desktop-contracts/file-preview'

/** 原生窗口创建前按文档用途确定比例，并统一缩放到所在屏幕的可用范围。 */
export function desktopPreviewBounds(
  file: Pick<DesktopPreviewMetadata, 'ext' | 'mimeType'>,
  area: { x: number; y: number; width: number; height: number },
  saved?: { width: number; height: number },
) {
  const ext = file.ext.toLowerCase()
  const [preferredWidth, preferredHeight] = ['csv', 'xlsx', 'xls'].includes(ext) ? [1080, 660]
    : ['ppt', 'pptx'].includes(ext) ? [1000, 620]
    : ['doc', 'docx', 'pdf', 'md', 'markdown', 'rtf'].includes(ext) || isTextExt(ext, file.mimeType) ? [680, 850]
    : [900, 670]
  const scale = Math.min(1, area.width / preferredWidth, area.height / preferredHeight)
  const width = saved ? Math.min(area.width, Math.max(360, saved.width)) : Math.floor(preferredWidth * scale)
  const height = saved ? Math.min(area.height, Math.max(260, saved.height)) : Math.floor(preferredHeight * scale)
  return {
    width, height, minWidth: Math.min(360, width), minHeight: Math.min(260, height),
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
  }
}
