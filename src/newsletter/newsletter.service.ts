import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NewsletterSubscriber } from '../models/newsletter/newsletter-subscriber.entity';
import { NewsletterCampaign } from '../models/newsletter/newsletter-campaign.entity';
import { EmailService } from '../email/email.service';
import { NewsletterOutboundQueueService } from './queues/newsletter-outbound.queue';
import type { NewsletterOutboundJobPayload } from './types/newsletter-outbound.types';

const HEXA_BRAND = {
  companyName: 'Hexa AI',
  companyLogo: 'https://gethexa.ai/_next/static/media/HexaRGBLogo.99148f1d.svg',
  companyPrimaryColor: '#d5b1ff',
  websiteUrl: 'https://gethexa.ai',
  supportUrl: 'mailto:support@hexa-ai.com',
};

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    @InjectRepository(NewsletterSubscriber)
    private readonly newsletterRepository: Repository<NewsletterSubscriber>,
    @InjectRepository(NewsletterCampaign)
    private readonly campaignRepository: Repository<NewsletterCampaign>,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
    private readonly outboundQueue: NewsletterOutboundQueueService,
  ) {}

  private unsubscribeLink(token: string): string {
    const base = this.config.get<string>('auth.frontendBaseUrl') ?? '';
    return `${base.replace(/\/$/, '')}/newsletter/unsubscribe?token=${token}`;
  }

  private readTemplate(fileName: string): string {
    const templatePath = path.join(process.cwd(), 'email_templates', fileName);
    return fs.readFileSync(templatePath, 'utf-8');
  }

  private getSubscriptionEmailTemplate(unsubscribeUrl: string): string {
    return this.readTemplate('newsletter_subscription_email.html')
      .replace(/{{company_name}}/g, HEXA_BRAND.companyName)
      .replace(/{{company_logo}}/g, HEXA_BRAND.companyLogo)
      .replace(/{{company_primary_color}}/g, HEXA_BRAND.companyPrimaryColor)
      .replace(/{{website_url}}/g, HEXA_BRAND.websiteUrl)
      .replace(/{{support_url}}/g, HEXA_BRAND.supportUrl)
      .replace(/{{unsubscribe_url}}/g, unsubscribeUrl);
  }

  private getBroadcastEmailTemplate(
    subject: string,
    contentHtml: string,
    unsubscribeUrl: string,
  ): string {
    return this.readTemplate('newsletter_broadcast_email.html')
      .replace(/{{company_name}}/g, HEXA_BRAND.companyName)
      .replace(/{{company_logo}}/g, HEXA_BRAND.companyLogo)
      .replace(/{{subject}}/g, subject)
      .replace(/{{content}}/g, contentHtml)
      .replace(/{{unsubscribe_url}}/g, unsubscribeUrl);
  }

  async subscribe(email: string): Promise<{ status: 'subscribed' }> {
    let subscriber = await this.newsletterRepository.findOne({ where: { email } });

    if (subscriber?.status === 'subscribed') {
      return { status: 'subscribed' };
    }

    if (subscriber) {
      subscriber.status = 'subscribed';
      subscriber.subscribedAt = new Date();
      subscriber.unsubscribedAt = null;
    } else {
      subscriber = this.newsletterRepository.create({
        email,
        status: 'subscribed',
        unsubscribeToken: randomBytes(32).toString('hex'),
        subscribedAt: new Date(),
      });
    }

    await this.newsletterRepository.save(subscriber);

    try {
      const unsubscribeUrl = this.unsubscribeLink(subscriber.unsubscribeToken);
      await this.emailService.sendMail({
        to: email,
        subject: `You're subscribed to ${HEXA_BRAND.companyName} updates`,
        html: this.getSubscriptionEmailTemplate(unsubscribeUrl),
        text: `Thanks for subscribing! You'll now receive promotions and updates from ${HEXA_BRAND.companyName}.\nUnsubscribe: ${unsubscribeUrl}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Subscriber saved but confirmation email failed: ${message}`);
    }

    return { status: 'subscribed' };
  }

  async unsubscribe(token: string): Promise<{ status: 'unsubscribed' }> {
    const subscriber = await this.newsletterRepository.findOne({
      where: { unsubscribeToken: token },
    });
    if (!subscriber) {
      throw new BadRequestException('Invalid unsubscribe token');
    }

    subscriber.status = 'unsubscribed';
    subscriber.unsubscribedAt = new Date();
    await this.newsletterRepository.save(subscriber);

    return { status: 'unsubscribed' };
  }

  async findAllActive(): Promise<NewsletterSubscriber[]> {
    return this.newsletterRepository.find({
      where: { status: 'subscribed' },
      order: { createdAt: 'DESC' },
    });
  }

  async broadcast(subject: string, html: string, text?: string): Promise<NewsletterCampaign> {
    const subscribers = await this.findAllActive();

    const campaign = await this.campaignRepository.save(
      this.campaignRepository.create({
        subject,
        html,
        text: text ?? null,
        status: 'sending',
        recipientCount: subscribers.length,
      }),
    );

    if (subscribers.length === 0) {
      campaign.status = 'completed';
      campaign.completedAt = new Date();
      await this.campaignRepository.update(campaign.id, {
        status: campaign.status,
        completedAt: campaign.completedAt,
      });
      return campaign;
    }

    const jobs: NewsletterOutboundJobPayload[] = subscribers.map(subscriber => {
      const link = this.unsubscribeLink(subscriber.unsubscribeToken);
      return {
        campaignId: campaign.id,
        subscriberId: subscriber.id,
        email: subscriber.email,
        subject,
        html: this.getBroadcastEmailTemplate(subject, html, link),
        text: text ? `${text}\n\nUnsubscribe: ${link}` : undefined,
        unsubscribeToken: subscriber.unsubscribeToken,
      };
    });

    await this.outboundQueue.enqueueMany(jobs);

    return campaign;
  }

  async findCampaign(id: string): Promise<NewsletterCampaign> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }
    return campaign;
  }

  async listCampaigns(): Promise<NewsletterCampaign[]> {
    return this.campaignRepository.find({ order: { createdAt: 'DESC' } });
  }
}
