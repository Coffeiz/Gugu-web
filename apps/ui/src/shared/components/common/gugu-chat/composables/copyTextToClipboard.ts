function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;top:-9999px;left:0;opacity:0'
  document.body.appendChild(textarea)

  try {
    textarea.focus()
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

/** 写入文本剪贴板；仅在浏览器确认写入后返回成功。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return copyWithExecCommand(text)
  }

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API 拒绝时明确返回命令回退的真实结果。
    return copyWithExecCommand(text)
  }
}
