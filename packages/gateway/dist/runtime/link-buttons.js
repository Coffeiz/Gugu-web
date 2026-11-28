import { validateLinkButtons } from '@gugu/core/tools';
import { packButtonRows } from '../platforms/button-rows.js';
export async function sendImLinkButtons(input) {
    const { wire, recipient, chatType, signal, authorize } = input;
    const failed = { status: 'failed', delivery: 'none', buttonCount: 0 };
    const unknown = { status: 'unknown' };
    const checked = validateLinkButtons(input.message, input.buttons);
    if ('error' in checked || signal.aborted || !await authorize())
        return failed;
    const { message, buttons } = checked;
    if (wire.platform === 'qq') {
        const receipt = await wire.sender.linkButtons?.({ id: recipient, chatType }, message, buttons, signal, authorize);
        if (!receipt || receipt.outcome === 'rejected')
            return failed;
        if (receipt.outcome === 'unknown')
            return unknown;
        return receipt.delivery === 'native' ? { status: 'sent', delivery: 'native', buttonCount: receipt.buttonCount }
            : { status: 'sent_with_fallback', delivery: 'text', buttonCount: receipt.buttonCount };
    }
    const https = buttons.filter(button => {
        try {
            return new URL(button.url).protocol === 'https:';
        }
        catch {
            return false;
        }
    });
    const text = [message, ...buttons.map(button => `· ${button.label}：${button.url}`)].join('\n');
    if (https.length === buttons.length && wire.platform !== 'wechat') {
        const native = wire.platform === 'feishu'
            ? await wire.sender.linkCard?.(recipient, message, https, signal, authorize)
            : await wire.sender.text?.({ chatId: recipient, chatType }, message, { signal, authorize,
                replyMarkup: { inline_keyboard: packButtonRows(https.map(button => ({ text: button.label, url: button.url })), button => button.text, 4) },
            });
        if (native?.outcome === 'accepted')
            return { status: 'sent', delivery: 'native', buttonCount: buttons.length };
        if (native?.outcome === 'unknown')
            return unknown;
    }
    if (signal.aborted || !await authorize())
        return failed;
    const receipt = wire.platform === 'feishu' ? await wire.sender.text?.(recipient, text, signal, authorize)
        : wire.platform === 'telegram' ? await wire.sender.text?.({ chatId: recipient, chatType }, text, { signal, authorize })
            : input.contextToken && chatType === 'c2c'
                ? await wire.sender.text?.({ userId: recipient, contextToken: input.contextToken }, text, signal, authorize)
                : undefined;
    return receipt?.outcome === 'accepted' ? { status: 'sent_with_fallback', delivery: 'text', buttonCount: buttons.length }
        : receipt?.outcome === 'unknown' ? unknown : failed;
}
