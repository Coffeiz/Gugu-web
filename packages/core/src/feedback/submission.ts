import { strip as normalizeFeedbackContent } from '../shared/values.js'

interface FeedbackSubmission {
  submit(ownerId: string, username: string, category: string, content: string): Promise<void>
}
export type FeedbackNotice = { ownerId: string; username: string; category: string; content: string }

/** 提交成功后读取通知偏好，再交由宿主安排发送。 */
export function createFeedbackSubmission<T extends FeedbackSubmission>(
  store: T,
  prepare: (notice: FeedbackNotice) => Promise<() => Promise<void>>,
  schedule: (work: () => Promise<void>) => void,
): T {
  return {
    ...store,
    async submit(ownerId: string, username: string, category: string, content: string) {
      await store.submit(ownerId, username, category, content)
      const send = await prepare({ ownerId, username, category, content: normalizeFeedbackContent(content) })
      schedule(send)
    },
  }
}
