import { createPersistentTelegramProjection as createProjection, type TelegramProjectionOptions } from '@gugu/gateway/telegram'
import { imAcceptedEvidence, type ImAcceptedSource } from '../../agent/evidence.js'
import type { ImAttachmentScope } from '../../inbound/attachments.js'

/** Web Host 注入图表渲染和原平台出站证据。 */
export function createPersistentTelegramProjection(options: Omit<TelegramProjectionOptions, 'acceptedEvidence'> & {
  acceptedEvidence?: { scope: ImAttachmentScope; recipient: string; source(): Promise<ImAcceptedSource> }
}) {
  const { acceptedEvidence, ...projection } = options
  return createProjection({
    ...projection,
    renderCharts: options.renderCharts ?? (async (request, signal) => (await import('../../../../agent/charts.js')).renderAgentCharts(request, signal)),
    ...(acceptedEvidence ? { acceptedEvidence: {
      scope: acceptedEvidence.scope,
      recipient: acceptedEvidence.recipient,
      async accept({ platformMessageIds, text }) {
        return imAcceptedEvidence({
          scope: acceptedEvidence.scope, recipient: acceptedEvidence.recipient,
          source: await acceptedEvidence.source(), kind: 'text', text,
          receipt: { outcome: 'accepted', platformMessageIds },
        })
      },
    } } : {}),
  })
}
