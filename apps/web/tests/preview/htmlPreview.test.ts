// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createHtmlPreviewDocument } from '@/utils/htmlPreview'

describe('HTML 文件预览文档', () => {
  it('同页锚点在 srcdoc 中仍指向预览文档，不会解析到宿主应用路由', () => {
    const document = new DOMParser().parseFromString(
      createHtmlPreviewDocument('<nav><a href="#map">功能地图</a></nav><section id="map">内容</section>'),
      'text/html',
    )
    const link = document.querySelector<HTMLAnchorElement>('a[href="#map"]')

    expect(link?.href).toBe('about:srcdoc#map')
    expect(document.getElementById('map')?.textContent).toBe('内容')
  })
})
