import { canAcceptInteractionText } from '@gugu/core/agent';
import { casefoldSearchText } from '@gugu/search';
import { asciiDecimalDigits, isDecimalDigits } from '@gugu/core/shared/unicode-decimal';
export function selectImTextChoice(prompt, text) {
    const value = text.trim();
    if (prompt.secret || !value)
        return null;
    if (['choice', 'confirm'].includes(prompt.kind) && Array.from(value).length <= 200) {
        const index = isDecimalDigits(value) ? Number(asciiDecimalDigits(value)) : 0;
        const folded = casefoldSearchText(value);
        const selected = (index >= 1 && index <= prompt.options.length ? prompt.options[index - 1] : undefined)
            ?? prompt.options.find(option => [option.id, option.label].some(label => casefoldSearchText(label.trim()) === folded));
        if (selected)
            return selected.token ? { action: 'option', token: selected.token } : null;
    }
    return canAcceptInteractionText(prompt)
        ? { action: 'text' } : null;
}
function sameScope(left, right) {
    return left.ownerId === right.ownerId && left.botId === right.botId && left.platform === right.platform &&
        left.chatType === right.chatType && left.chatId === right.chatId && left.platformUserId === right.platformUserId;
}
export function createImTextChoiceConsumer(options) {
    const { service, consumeText } = options;
    if ((!service?.resumeText && !consumeText) || typeof options.find !== 'function' || typeof options.authorize !== 'function')
        throw new TypeError('IM 文本交互服务未完整配置');
    return async (scope, text, signal) => {
        signal.throwIfAborted();
        const prompts = await options.find(scope, signal, text);
        // 已提交动作而普通inbox收据尚未落地的重试；lookup必须按scope+event定位原消费。
        if ('replayed' in prompts)
            return { status: 'replay' };
        for (const prompt of prompts) {
            if (!sameScope(prompt.scope, scope) || !Number.isSafeInteger(prompt.promptId) || prompt.promptId <= 0 ||
                !Number.isSafeInteger(prompt.sessionId) || prompt.sessionId <= 0)
                throw new Error('IM 交互作用域无效');
            const choice = selectImTextChoice(prompt, text);
            if (!choice || (choice.action === 'option' && !service?.respond))
                continue;
            signal.throwIfAborted();
            if (!await options.authorize(scope, prompt.promptId, prompt.sessionId, signal))
                throw new Error('IM 交互授权已失效');
            const result = choice.action === 'option'
                ? await service.respond(scope.ownerId, prompt.promptId, choice.token, scope.eventId || undefined)
                : consumeText ? await consumeText(prompt, text, scope, signal)
                    : await service.resumeText(scope.ownerId, prompt.promptId, text, scope.eventId || undefined, ...(prompt.questionIndex === undefined ? [] : [prompt.questionIndex]));
            if (result.session_id !== prompt.sessionId || result.prompt_id !== prompt.promptId)
                throw new Error('IM 交互返回作用域无效');
            if (result.result.status === 'question_replay')
                return { status: 'replay' };
            if (result.result.status === 'question_next')
                return { status: 'question_next', text: String(result.result.text) };
            if (prompt.questionIndex !== undefined) {
                if (result.result.status === 'cancelled')
                    return { status: 'question_next', text: '已取消问答。' };
                if (result.result.status === 'answered')
                    return { status: 'question_next', text: '已提交全部答案，咕咕会继续处理。' };
            }
            if (result.result.status === 'error')
                return { status: 'error' };
            return result.result.status === 'awaiting_text' ? { status: 'awaiting_text' }
                : { status: 'selected', ...(typeof result.result.text === 'string' ? { text: result.result.text } : {}) };
        }
        return null;
    };
}
