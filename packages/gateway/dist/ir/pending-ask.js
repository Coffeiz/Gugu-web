/** 飞书与 Telegram 群聊 ASK 的共享延迟策略；存储和唤醒由宿主适配。 */
export const IM_PENDING_ASK_MIN_WAIT_MS = 60_000;
export const IM_PENDING_ASK_QUIET_MS = 30_000;
export const IM_PENDING_ASK_MAX_WAIT_MS = 180_000;
/** 最后一条 ASK 至少等待一分钟，群安静三十秒后唤醒，最长等待三分钟。 */
export function imPendingAskDueAt(state) {
    return Math.min(Math.max(state.startedAt + IM_PENDING_ASK_MIN_WAIT_MS, state.latestAskAt + IM_PENDING_ASK_MIN_WAIT_MS, state.latestActivityAt + IM_PENDING_ASK_QUIET_MS), state.startedAt + IM_PENDING_ASK_MAX_WAIT_MS);
}
export function isImPendingAskReady(state, now) {
    return now >= state.latestAskAt + IM_PENDING_ASK_MIN_WAIT_MS
        && now - state.latestActivityAt >= IM_PENDING_ASK_QUIET_MS;
}
/** 各宿主共用唤醒顺序；存储负责 claim/CAS，宿主负责重新授权和派发。 */
export async function pumpImPendingAsks(options, signal) {
    let dispatched = 0;
    for (const resume of await options.store.claimDue(100, signal)) {
        signal.throwIfAborted();
        if (!await options.store.isCurrent(resume, signal))
            continue;
        if (await options.store.isCancelled(resume, signal)) {
            await options.store.complete(resume, signal);
            continue;
        }
        if (!await options.authorize(resume, signal)) {
            await options.store.complete(resume, signal);
            continue;
        }
        if (!await options.store.isCurrent(resume, signal) || await options.store.isCancelled(resume, signal))
            continue;
        await options.dispatch(resume, signal);
        await options.store.complete(resume, signal);
        dispatched++;
    }
    return dispatched;
}
