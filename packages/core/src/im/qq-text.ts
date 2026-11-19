/** QQ 链接展示规则；不修改 Canonical 正文，只在出站或完整行刷新时调用。 */
const unsupportedNotice = '（QQ 不支持直接打开此链接）';
const whitespace = '\\p{White_Space}\\x1c-\\x1f';
const word = '\\p{L}\\p{N}_';

function webTarget(target: string): string | null {
  // urlsplit 会移除 CR/LF/TAB 和开头控制字符，但 HTTP 链接仍返回原文。
  const value = target.replace(/[\r\n\t]/g, '').replace(/^[\x00-\x20]+/, '');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') return target;
  const match = /^baidumap:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(value);
  if (!match || match[1]!.toLowerCase() !== 'map' || match[2] !== '/place/detail') return null;
  // parse_qs 默认丢弃空值，重复的非空 uid 则不允许猜测。
  const ids = new URLSearchParams(match[3] ?? '').getAll('uid').filter(Boolean);
  if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(ids[0]!)) return null;
  return `https://api.map.baidu.com/place/detail?uid=${ids[0]}&output=html`;
}
function sanitizeImLinks(text: string): string {
  return text
    .replace(new RegExp(`\\[([^\\]\\n]+)\\]\\(gugu://[^)${whitespace}]+\\)`, 'giu'), '$1')
    .replace(new RegExp(`(?<![${word}])gugu://[^${whitespace})]+`, 'giu'), '');
}
export function completeQqLines(text: string): string { return text.slice(0, text.lastIndexOf('\n') + 1); }
export function prepareQqText(text: string, options: { final?: boolean } = {}): string {
  let result = sanitizeImLinks(options.final === false ? completeQqLines(text) : text);
  result = result.replace(new RegExp(`\\[([^\\]\\n]*)\\]\\(([^${whitespace})]*)(\\)?)`, 'gu'), (_match, label: string, target: string) => {
    const replacement = webTarget(target);
    return replacement ? `[${label}](${replacement})` : label + unsupportedNotice;
  });
  return result.replace(new RegExp(`(?<![${word}])([a-zA-Z][a-zA-Z0-9+.-]*):/{1,2}[^${whitespace}<>\u0060\\[\\]（）()]*`, 'gu'), (match, scheme: string) => {
    if (['http', 'https'].includes(scheme.toLowerCase())) return match;
    return webTarget(match) ?? unsupportedNotice;
  });
}
export interface QqLinkButton { id: string; label: string; url: string }
export function prepareQqLinkButtons<T extends QqLinkButton>(buttons: readonly T[]): { supported: T[]; unsupported: T[] } {
  const supported: T[] = [], unsupported: T[] = [];
  for (const button of buttons) {
    const target = webTarget(button.url);
    if (target === null) unsupported.push({ ...button });
    else supported.push({ ...button, url: target });
  }
  return { supported, unsupported };
}
export function prepareQqLinkButtonMessage<T extends QqLinkButton>(message: string, buttons: readonly T[]) {
  const { supported, unsupported } = prepareQqLinkButtons(buttons);
  let text = prepareQqText(message);
  const details: { requested_button_count?: number; unsupported_button_ids?: string[] } = {};
  if (unsupported.length) {
    text += '\n' + unsupported.map(button => `· ${button.label}：QQ 不支持直接打开此链接`).join('\n');
    details.requested_button_count = buttons.length;
    details.unsupported_button_ids = unsupported.map(button => button.id);
  }
  return { text, supported, details };
}
