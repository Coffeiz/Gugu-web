import { describe, expect, it } from 'vitest';
import { completeQqLines, prepareQqLinkButtonMessage, prepareQqLinkButtons, prepareQqText } from '../../src/im/qq-text.js';

const map = '[示例店铺](baidumap://map/place/detail?uid=synthetic_poi&src=web.demo)';
const web = '[示例店铺](https://api.map.baidu.com/place/detail?uid=synthetic_poi&output=html)';
describe('QQ 出站链接纯规则（Python text.py 行为）', () => {
  it('百度POI转网页，HTTP原文保持，不能猜测其他地图路由', () => {
    expect(prepareQqText(map)).toBe(web); expect(prepareQqText(web)).toBe(web);
    expect(map).toContain('baidumap://');
    expect(prepareQqText('baidumap://map/place/detail?uid=a_-1')).toBe('https://api.map.baidu.com/place/detail?uid=a_-1&output=html');
  });
  it.each(['[打开](unknownapp://map/detail)', 'unknownapp://map/detail', '[打开](baidumap://map/place/detail?uid=one&uid=two)', '[打开](baidumap://map/nearbysearch?query=demo)', '[打开](baidumap://map/place/detail?uid=a%2Fb)'])('不支持的入口保留说明并清理非HTTP协议：%s', text => {
    const result = prepareQqText(text); expect(result).toContain('QQ 不支持'); expect(result).not.toContain('://');
  });
  it('清除Web内部动作链接，只保留可读标签', () => {
    expect(prepareQqText('[打开项目](gugu://project/1) gugu://note/2')).toBe('打开项目 ');
    expect(prepareQqText('[打开](unknownapp://map')).toBe('打开（QQ 不支持直接打开此链接）');
  });
  it.each([map, 'baidumap://map/place/detail?uid=synthetic_poi', '[打开](https://example.com/path)'])('任意半链接不会进入未完成行的流前缀：%s', text => {
    for (let end = 0; end <= text.length; end++) {
      const result = prepareQqText(text.slice(0, end), { final: false });
      expect(result).not.toMatch(/(?:baidumap|unknownapp):\//); expect(result).not.toMatch(/\]\([^)]*$/);
    }
  });
  it.each(['说明：\n- `baidumap://` 能转换，`demoapp://` 不支持\n结尾', `开头\n${map}\n[未知](demoapp://map/detail)\n末行`, '首行\nbaidumap://map/place/detail?uid=synthetic_poi\n尾行', '开头\n[gugu](gugu://project/1)\n末行', '开头\n[未完成](demoapp://map\n下一行'])('完整行逐字flush保持已确认前缀，最终追加尾行：%s', text => {
    let previous = '';
    for (let end = 0; end <= text.length; end++) {
      const current = prepareQqText(text.slice(0, end), { final: false });
      expect(current.startsWith(previous)).toBe(true); previous = current;
    }
    expect(prepareQqText(text).startsWith(previous)).toBe(true);
  });
  it('混合按钮保留支持项并准确报告不支持入口，不改写调用方对象', () => {
    const buttons = [{ id: 'map', label: '地点', url: 'baidumap://map/place/detail?uid=one' }, { id: 'app', label: '应用', url: 'demoapp://home' }, { id: 'web', label: '网页', url: 'https://example.com/' }];
    const prepared = prepareQqLinkButtons(buttons);
    expect(prepared.supported.map(button => button.id)).toEqual(['map', 'web']); expect(prepared.unsupported.map(button => button.id)).toEqual(['app']);
    expect(buttons[0]!.url).toContain('baidumap://');
    expect(prepareQqLinkButtonMessage('选择', buttons)).toEqual({ text: '选择\n· 应用：QQ 不支持直接打开此链接', supported: prepared.supported, details: { requested_button_count: 3, unsupported_button_ids: ['app'] } });
    expect(prepareQqLinkButtonMessage('选择', [])).toEqual({ text: '选择', supported: [], details: {} });
  });
  it('只刷新完整行，末尾CR及未完成行保持Python切片行为', () => {
    expect(completeQqLines('首行\r\n尾行')).toBe('首行\r\n'); expect(completeQqLines('尾行')).toBe('');
  });
});
