export const groupDisabledNoticeText = '这个机器人还未开启群聊，请在咕咕的接入设置里开启。';
/** 名额在发送前持久化。结果不确定时保留名额，避免重复出站。 */
export async function notifyGroupDisabled(options) {
    try {
        if (!options.mentioned || !await options.authorize())
            return;
        const release = await options.store.claim();
        if (!release)
            return;
        if (!await options.authorize() || await options.send(options.authorize) === 'rejected')
            await release();
    }
    catch {
        // 提示失败不能改变原消息的处置或触发平台重投。
    }
}
