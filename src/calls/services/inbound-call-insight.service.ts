import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../../clients/openai/openai.client';
import { OpenAIModel } from '../../common/enums';
import { CallRecordService } from './call-record.service';

/** Stored under call_records.metadata.inboundInsight */
export interface InboundCallInsight {
  category: InboundCallInsightCategory;
  purpose: string;
  summary: string;
}

export type InboundCallInsightCategory =
  | 'query'
  | 'bug_report'
  | 'demo_request'
  | 'support'
  | 'sales'
  | 'feedback'
  | 'other';

@Injectable()
export class InboundCallInsightService {
  private readonly logger = new Logger(InboundCallInsightService.name);

  constructor(
    private readonly openaiClient: OpenAIClient,
    private readonly callRecordService: CallRecordService,
  ) {}

  /**
   * Classifies the inbound call and merges structured fields into the persistent call record.
   */
  async persistAfterInboundCall(callSid: string, transcript: string): Promise<void> {
    const trimmed = transcript.trim();
    if (trimmed.length < 8) {
      await this.callRecordService.mergeMetadata(callSid, {
        inboundInsight: {
          category: 'other' as const,
          purpose: 'Short or empty conversation',
          summary: trimmed || '(no transcript)',
        },
      });
      return;
    }

    try {
      const raw = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content: `You classify phone support/sales calls for a SaaS platform (e.g. Hexa AI).
Return ONLY valid JSON with keys: category, purpose, summary.
category must be one of: query, bug_report, demo_request, support, sales, feedback, other.
purpose: one short line describing why they called.
summary: 2-4 sentences in English describing what was discussed and any action items.`,
          },
          {
            role: 'user',
            content: `Transcript:\n${trimmed.slice(0, 12000)}`,
          },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.2, maxTokens: 500 },
      );

      const insight = this.parseInsightJson(raw);
      await this.callRecordService.mergeMetadata(callSid, {
        inboundInsight: insight,
        inboundTranscriptPreview: trimmed.slice(0, 2000),
      });
      this.logger.log(`Inbound insight saved for ${callSid} (${insight.category})`);
    } catch (error) {
      this.logger.error(`Inbound insight failed for ${callSid}:`, error);
    }
  }

  private parseInsightJson(raw: string): InboundCallInsight {
    const allowed: InboundCallInsightCategory[] = [
      'query',
      'bug_report',
      'demo_request',
      'support',
      'sales',
      'feedback',
      'other',
    ];
    try {
      const jsonMatch = /\{[\s\S]*}/.exec(raw);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Record<string, unknown>;
      const category = allowed.includes(parsed.category as InboundCallInsightCategory)
        ? (parsed.category as InboundCallInsightCategory)
        : 'other';
      const purposeStr =
        typeof parsed.purpose === 'string' ? parsed.purpose.slice(0, 500) : 'Unknown';
      const summaryStr =
        typeof parsed.summary === 'string' ? parsed.summary.slice(0, 2000) : raw.slice(0, 500);
      return {
        category,
        purpose: purposeStr || 'Unknown',
        summary: summaryStr,
      };
    } catch {
      return {
        category: 'other',
        purpose: 'Unparsed model output',
        summary: raw.slice(0, 2000),
      };
    }
  }
}
