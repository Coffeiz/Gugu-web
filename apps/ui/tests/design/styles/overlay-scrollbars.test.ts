// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installOverlayScrollbars } from '@/utils/overlayScrollbars'

afterEach(() => { vi.unstubAllGlobals() })

it('普通滚动区继承所在的层叠上下文，弹窗内的滚动区也沿用同一规则', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('MutationObserver', class { observe() {} })
  document.body.innerHTML = `
    <div id="workspace" style="isolation:isolate;position:relative">
      <div class="scroll-surface scroll-surface--editor"></div>
    </div>
    <div id="floating" style="position:fixed;z-index:25">
      <div class="scroll-surface"></div>
    </div>
  `
  installOverlayScrollbars()

  expect(document.querySelector('#workspace > [data-overlay-scrollbar-thumb]')).not.toBeNull()
  expect(document.querySelector('#floating > [data-overlay-scrollbar-thumb]')).not.toBeNull()
  expect(document.querySelector('body > [data-overlay-scrollbar-thumb]')).toBeNull()
})
