// @vitest-environment jsdom
import { effectScope } from 'vue'
import { expect, it } from 'vitest'
import { useFileViewMode } from '@/composables/files/useFileViewMode'

it('重新打开时分别恢复文件库和项目编辑卡的视图', () => {
  const first = effectScope()
  const reopened = effectScope()
  try {
    const library = first.run(() => useFileViewMode('library'))!
    const project = first.run(() => useFileViewMode('project-editor'))!
    library.value = 'list'
    project.value = 'list'
    library.value = 'grid'
    first.stop()

    expect(reopened.run(() => useFileViewMode('library'))?.value).toBe('grid')
    expect(reopened.run(() => useFileViewMode('project-editor'))?.value).toBe('list')
  } finally {
    first.stop()
    reopened.stop()
    localStorage.removeItem('gugu-file-view-mode-library')
    localStorage.removeItem('gugu-file-view-mode-project-editor')
  }
})
