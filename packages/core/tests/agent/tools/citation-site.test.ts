import { expect, it, vi } from 'vitest'
import { createCitationSiteLookup, readCitationSiteName } from '../../../src/agent/tools/citation-site.js'

it('优先读取网站声明的名称，也支持结构化发布者和无元数据页面', () => {
  const publisher = '<script type="application/ld+json">{"@graph":[{"publisher":{"name":"发布者"}}]}</script>'
  expect(readCitationSiteName(publisher)).toBe('发布者')
  expect(readCitationSiteName(`${publisher}<meta content="站点 &amp; 名称" property="og:site_name">`)).toBe('站点 & 名称')
  expect(readCitationSiteName('<title>文章标题</title>')).toBeNull()
  expect(readCitationSiteName('<title>示例新闻_站点口号</title>', true)).toBe('示例新闻')
  expect(readCitationSiteName('<title>示例财经 - 实时财经资讯</title>', true)).toBe('示例财经')
  expect(readCitationSiteName('<meta name="application-name" content="示例应用">')).toBe('示例应用')
})

it('复用同站点查询，跨站跳转也交给安全传输，并移除查询参数', async () => {
  const cancel = vi.fn()
  const request = vi.fn()
    .mockResolvedValueOnce({ status: 302, headers: { location: 'https://www.example.org/post?token=synthetic' }, cancel })
    .mockResolvedValueOnce({
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, cancel,
      body: (async function* () { yield Buffer.from('<meta property="og:site_name" content="合成站点">') })(),
    })
  const lookup = createCitationSiteLookup({
    withTransport: async (_signal, execute) => execute({ request }),
  })
  await expect(Promise.all([lookup('https://example.org/a?tracking=synthetic'),
    lookup('https://example.org/b')])).resolves.toEqual(['合成站点', '合成站点'])
  expect(request.mock.calls.map(([input]) => input.url)).toEqual(['https://example.org/a', 'https://www.example.org/post'])
  expect(cancel).toHaveBeenCalledTimes(2)
})

it('文章缺少站点元数据时，从同源首页识别站点名', async () => {
  const request = vi.fn(async ({ url }: { url: string }) => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: (async function* () {
      yield Buffer.from(url.endsWith('/') ? '<title>示例新闻_站点口号</title>' : '<title>一篇文章</title>')
    })(),
    cancel: vi.fn(),
  }))
  const lookup = createCitationSiteLookup({
    withTransport: async (_signal, execute) => execute({ request }),
  })
  await expect(lookup('https://example.org/articles/1')).resolves.toBe('示例新闻')
  expect(request.mock.calls.map(([input]) => input.url)).toEqual([
    'https://example.org/articles/1', 'https://example.org/',
  ])
})
