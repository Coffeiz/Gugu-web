import { createPersistentQqProjection as createProjection, type QqProjectionOptions, type QqReceipt, createQqChartPreparation } from '@gugu/gateway/qq'
import { imAcceptedEvidence, type ImAcceptedSource } from '../../agent/evidence.js'
import type { ImAttachmentScope } from '../../inbound/attachments.js'
import type { ImChartRenderer } from '@gugu/gateway'

/** Web Host 只注入平台图表能力、出站证据及持久存储。 */
export function createPersistentQqProjection(options: Omit<QqProjectionOptions, 'charts' | 'acceptedEvidence'> & {
  acceptedEvidence?: { scope: ImAttachmentScope; recipient: string; source(): Promise<ImAcceptedSource> }
  sendChart?(png: Uint8Array): Promise<QqReceipt>
  renderCharts?: ImChartRenderer
}) {
  const { acceptedEvidence, sendChart, renderCharts, ...projection } = options
  const charts = sendChart ? createQqChartPreparation(options.authorize,
    renderCharts ?? (async (request, signal) => (await import('../../../../agent/charts.js')).renderAgentCharts(request, signal)),
    sendChart) : undefined
  return createProjection({
    ...projection,
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
    ...(charts ? { charts } : {}),
  })
}
