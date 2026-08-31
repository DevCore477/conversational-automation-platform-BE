export interface NewsletterOutboundJobPayload {
  campaignId: string;
  subscriberId: string;
  email: string;
  subject: string;
  html: string;
  text?: string;
  unsubscribeToken: string;
}

export const NEWSLETTER_OUTBOUND_QUEUE = 'newsletter-outbound';
