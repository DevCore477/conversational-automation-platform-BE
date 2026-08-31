import { WhatsAppCampaignStatus } from '../../common/enums/whatsapp.enum';

/** True when every queued recipient has a terminal delivery outcome. */
export function shouldCompleteCampaign(
  status: WhatsAppCampaignStatus,
  queuedCount: number,
  terminalMessageCount: number,
): boolean {
  return (
    status === WhatsAppCampaignStatus.SENDING &&
    queuedCount > 0 &&
    terminalMessageCount >= queuedCount
  );
}
