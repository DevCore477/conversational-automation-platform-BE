import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';

import { OpenAIClient } from '../../clients/openai/openai.client';
import { WhatsAppMediaKind, WhatsAppMessageDirection } from '../../common/enums/whatsapp.enum';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppMessageMedia } from '../../models/whatsapp/whatsapp-message-media.entity';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';
import { rankBySimilarity } from '../utils/whatsapp-embedding.util';

const MAX_CONTEXT_CHARS = 12_000;
const MAX_EXTRACTED_TEXT_SNIPPET = 1500;

export interface ContextTurn {
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: Date;
  lines: string[];
  /** True when this turn was pulled in via semantic retrieval rather than the recency window. */
  isSemanticMatch?: boolean;
}

/**
 * Builds structured, multimodal-aware conversation context (text + image analysis + transcripts +
 * extracted document text) shared by both the OpenAI reply path and the flow-runtime reply path.
 * Replaces the old flat "Customer: ..." text-line join, which had no media understanding.
 */
@Injectable()
export class WhatsAppContextBuilderService {
  private readonly logger = new Logger(WhatsAppContextBuilderService.name);

  constructor(
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
    @InjectRepository(WhatsAppMessageMedia)
    private readonly mediaRepo: Repository<WhatsAppMessageMedia>,
    private readonly openaiClient: OpenAIClient,
    private readonly configService: ConfigService,
  ) {}

  async getMediaByRowId(mediaRowId: string): Promise<WhatsAppMessageMedia | null> {
    return this.mediaRepo.findOne({ where: { id: mediaRowId } });
  }

  /** Text surrogate for the current turn when the user sent media without a caption. */
  describeCurrentMedia(media: WhatsAppMessageMedia | null): string {
    if (!media) {
      return '';
    }
    return (
      media.visionDescription || media.transcript || media.extractedText || media.sceneSummary || ''
    );
  }

  /** Chat-history seed for the OpenAI path — role carries the speaker, so no label prefix needed. */
  async buildChatHistorySeed(params: {
    conversationId: string;
    currentQueryText?: string;
    excludeMessageId?: string;
  }): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const turns = await this.gatherTurns(params);
    return turns.map(t => ({ role: t.role, content: t.lines.join('\n') }));
  }

  /** Flat prose block for the flow-runtime path, matching its existing "Customer:"/"Business:" convention. */
  async buildFlowContextBlock(params: {
    conversationId: string;
    currentQueryText?: string;
    excludeMessageId?: string;
  }): Promise<string | undefined> {
    const turns = await this.gatherTurns(params);
    if (turns.length === 0) {
      return undefined;
    }
    const rendered = turns.map(t => {
      const label = t.role === 'assistant' ? 'Business' : 'Customer';
      const suffix = t.isSemanticMatch ? ` (${this.relativeTime(t.createdAt)})` : '';
      return `${label}${suffix}:\n${t.lines.map(l => `  ${l}`).join('\n')}`;
    });
    return `Recent WhatsApp thread:\n${rendered.join('\n')}`;
  }

  private async gatherTurns(params: {
    conversationId: string;
    currentQueryText?: string;
    excludeMessageId?: string;
  }): Promise<ContextTurn[]> {
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const recencyWindow = wa?.contextRecencyWindow ?? 40;

    const recentMessages = await this.messageRepo.find({
      where: { conversationId: params.conversationId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: recencyWindow,
    });
    recentMessages.reverse();

    const filtered = params.excludeMessageId
      ? recentMessages.filter(m => m.id !== params.excludeMessageId)
      : recentMessages;

    if (filtered.length === 0) {
      return [];
    }

    const mediaByMessageId = await this.loadMediaFor(filtered.map(m => m.id));
    const recencyTurns = filtered.map(m => this.renderTurn(m, mediaByMessageId.get(m.id)));

    const semanticTurns = await this.findSemanticMatches({
      conversationId: params.conversationId,
      currentQueryText: params.currentQueryText,
      excludeMessageIds: new Set([...filtered.map(m => m.id), params.excludeMessageId].filter(Boolean) as string[]),
      earliestRecencyCreatedAt: filtered[0]?.createdAt ?? new Date(),
    });

    const merged = [...semanticTurns, ...recencyTurns].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return this.trimToTokenBudget(merged);
  }

  private async loadMediaFor(messageIds: string[]): Promise<Map<string, WhatsAppMessageMedia>> {
    if (messageIds.length === 0) {
      return new Map();
    }
    const rows = await this.mediaRepo.find({ where: { messageId: In(messageIds) } });
    return new Map(rows.map(r => [r.messageId, r]));
  }

  private async findSemanticMatches(params: {
    conversationId: string;
    currentQueryText?: string;
    excludeMessageIds: Set<string>;
    earliestRecencyCreatedAt: Date;
  }): Promise<ContextTurn[]> {
    if (!params.currentQueryText?.trim()) {
      return [];
    }

    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const poolSize = wa?.contextSemanticCandidatePool ?? 300;
    const topN = wa?.contextSemanticTopN ?? 3;

    const candidates = await this.mediaRepo.find({
      where: {
        conversationId: params.conversationId,
        createdAt: LessThan(params.earliestRecencyCreatedAt),
      },
      order: { createdAt: 'DESC' },
      take: poolSize,
    });

    const eligible = candidates.filter(c => !params.excludeMessageIds.has(c.messageId));
    if (eligible.length === 0) {
      return [];
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = (await this.openaiClient.createEmbedding(params.currentQueryText)).embedding;
    } catch (err) {
      this.logger.warn(`Semantic retrieval embedding failed, skipping: ${(err as Error).message}`);
      return [];
    }

    const ranked = rankBySimilarity(
      eligible.map(c => ({ id: c.messageId, embedding: c.embedding, media: c })),
      queryEmbedding,
      topN,
    );

    const messages = await this.messageRepo.find({ where: { id: In(ranked.map(r => r.id)) } });
    const messageById = new Map(messages.map(m => [m.id, m]));

    return ranked
      .map(r => {
        const message = messageById.get(r.id);
        if (!message) {
          return null;
        }
        const turn = this.renderTurn(message, r.media);
        turn.isSemanticMatch = true;
        return turn;
      })
      .filter((t): t is ContextTurn => t !== null);
  }

  private renderTurn(message: WhatsAppMessage, media?: WhatsAppMessageMedia): ContextTurn {
    const role = message.direction === WhatsAppMessageDirection.OUTBOUND ? 'assistant' : 'user';
    const lines = media ? this.renderMediaLines(message, media) : [message.body?.trim() || `[${message.messageType}]`];

    return { messageId: message.id, role, createdAt: message.createdAt, lines };
  }

  private renderMediaLines(message: WhatsAppMessage, media: WhatsAppMessageMedia): string[] {
    const lines: string[] = [];
    const caption = message.body?.trim();

    switch (media.mediaType) {
      case WhatsAppMediaKind.IMAGE:
      case WhatsAppMediaKind.STICKER:
        lines.push(`Image${media.mediaType === WhatsAppMediaKind.STICKER ? ' (sticker)' : ''}`);
        if (caption) lines.push(`Caption: "${caption}"`);
        if (media.visionDescription) lines.push(`Image Analysis: "${media.visionDescription}"`);
        if (media.ocrText) lines.push(`OCR Text: "${media.ocrText}"`);
        break;
      case WhatsAppMediaKind.VIDEO:
        lines.push('Video');
        if (caption) lines.push(`Caption: "${caption}"`);
        if (media.sceneSummary) lines.push(`Video Analysis: "${media.sceneSummary}"`);
        if (media.transcript) lines.push(`Video Transcript: "${media.transcript}"`);
        break;
      case WhatsAppMediaKind.AUDIO:
        lines.push('Voice Note');
        lines.push(media.transcript ? `Transcript: "${media.transcript}"` : '(audio could not be transcribed)');
        break;
      case WhatsAppMediaKind.DOCUMENT:
        lines.push(`Document${caption ? `: ${caption}` : ''}`);
        if (media.extractedText) {
          lines.push(`Extracted text: "${this.truncate(media.extractedText, MAX_EXTRACTED_TEXT_SNIPPET)}"`);
        } else {
          lines.push('(document could not be read)');
        }
        break;
      case WhatsAppMediaKind.LOCATION:
      case WhatsAppMediaKind.CONTACT:
        lines.push(media.sceneSummary || `[${media.mediaType}]`);
        break;
      default:
        lines.push(media.errorMessage ? `[unsupported attachment: ${media.errorMessage}]` : '[unsupported attachment]');
    }

    return lines;
  }

  private trimToTokenBudget(turns: ContextTurn[]): ContextTurn[] {
    let totalChars = turns.reduce((sum, t) => sum + t.lines.join('\n').length, 0);
    const result = [...turns];
    while (totalChars > MAX_CONTEXT_CHARS && result.length > 1) {
      const dropped = result.shift();
      if (!dropped) break;
      totalChars -= dropped.lines.join('\n').length;
    }
    return result;
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  private relativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'earlier today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
  }
}
