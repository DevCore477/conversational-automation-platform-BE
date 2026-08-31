import { WhatsAppCampaignStatus } from '../../common/enums/whatsapp.enum';
import { shouldCompleteCampaign } from './campaign-completion.util';

describe('campaign-completion.util', () => {
  it('completes when all queued messages reached a terminal state', () => {
    expect(
      shouldCompleteCampaign(WhatsAppCampaignStatus.SENDING, 3, 3),
    ).toBe(true);
  });

  it('stays sending while delivery confirmations are pending', () => {
    expect(
      shouldCompleteCampaign(WhatsAppCampaignStatus.SENDING, 3, 2),
    ).toBe(false);
  });

  it('does not complete campaigns that are already finished', () => {
    expect(
      shouldCompleteCampaign(WhatsAppCampaignStatus.COMPLETED, 3, 3),
    ).toBe(false);
  });
});
