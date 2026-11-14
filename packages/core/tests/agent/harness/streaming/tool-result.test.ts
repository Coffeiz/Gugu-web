import { describe,expect,it } from 'vitest'
import { projectPersistentToolResult,redactToolError } from "../../../../src/agent/harness/index.js"

describe('工具结果持久化与展示通用投影', () => {
  it.each([['image', '图片'], ['video', '视频'], ['audio', '音频']] as const)('%s媒体在任意嵌套位置用占位替代，不把原始载荷写入展示/历史', (type, label) => {
    expect(projectPersistentToolResult({ nested: [{ content: [{ type, source: { type: 'base64', data: 'synthetic-private-media' } }] }] })).toEqual({ nested: [{ content: [{ type: 'text', text: `[${label}已查看]` }] }] })
  })

  it('data image_url替换但远程授权引用保留，普通业务正文不受错误脱敏影响', () => {
    const content = '正常read_file正文：/home/synthetic/report.txt，token=synthetic-token-1234567890'
    const result = projectPersistentToolResult({ content, media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] })
    expect(result).toEqual({ content, media: [{ type: 'text', text: '[图片已查看]' }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] })
  })

  it('error字段递归脱敏连接串/密钥/路径/UUID，成功字段保持原结果', () => {
    const error = 'postgresql://synthetic:synthetic@example.test/synthetic token=synthetic-token-1234567890 /home/synthetic/report.txt 00000000-0000-4000-8000-000000000000'
    const result = projectPersistentToolResult({ ok: true, failures: [{ error }], content: '正常业务内容' })
    expect(result).toEqual({ ok: true, failures: [{ error: '‹连接串已隐藏› ‹密钥已隐藏› ‹路径已隐藏› ‹id已隐藏›' }], content: '正常业务内容' })
    expect(redactToolError('失败\n  File "synthetic.py", line 2, in run\n    synthetic_call()')).toBe('失败')
  })

  it('JSON字符串容器中的媒体/error同样投影，未改变的原始结果文本不重排空白', () => {
    const raw = '{ "ok" : true, "items" : [ 1, 2 ] }'
    expect(projectPersistentToolResult(raw)).toBe(raw)
    const encoded = JSON.stringify({ result: [{ type: 'video', source: { data: 'synthetic-private-media' } }], failed: [{ error: '/home/synthetic/private.txt' }] })
    const result = projectPersistentToolResult(encoded)
    expect(typeof result).toBe('string')
    expect(JSON.parse(result as string)).toEqual({ failed: [{ error: '‹路径已隐藏›' }], result: [{ type: 'text', text: '[视频已查看]' }] })
  })
})
