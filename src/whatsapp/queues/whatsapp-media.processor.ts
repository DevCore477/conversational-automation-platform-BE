import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Worker, type Job } from 'bullmq';
import { Repository } from 'typeorm';

import { OpenAIClient } from '../../clients/openai/openai.client';
import {
  WhatsAppJobType,
  WhatsAppMediaKind,
  WhatsAppMediaProcessingStatus,
} from '../../common/enums/whatsapp.enum';
import redisConfig from '../../configs/redis.config';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppMessageMedia } from '../../models/whatsapp/whatsapp-message-media.entity';
import { S3Service } from '../../s3/s3.service';
import { WhatsAppAudioTranscriptionService } from '../services/media/whatsapp-audio-transcription.service';
import { WhatsAppDocumentExtractionService } from '../services/media/whatsapp-document-extraction.service';
import { WhatsAppVideoProcessingService } from '../services/media/whatsapp-video-processing.service';
import {
  type ImageAnalysis,
  WhatsAppVisionService,
} from '../services/media/whatsapp-vision.service';
import { WhatsAppConfigService } from '../services/whatsapp-config.service';
import { WhatsAppQueueService } from '../services/whatsapp-queue.service';
import { WHATSAPP_MEDIA_QUEUE, type WhatsAppMediaJobPayload } from '../types/whatsapp-media.types';
import { buildRedisConnectionOptions } from './redis-connection.util';

const MAX_EMBEDDING_INPUT_CHARS = 6000;

@Injectable()
export class WhatsAppMediaProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppMediaProcessor.name);
  private worker: Worker<WhatsAppMediaJobPayload> | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(WhatsAppMessageMedia)
    private readonly mediaRepo: Repository<WhatsAppMessageMedia>,
    private readonly waConfigService: WhatsAppConfigService,
    private readonly s3Service: S3Service,
    private readonly visionService: WhatsAppVisionService,
    private readonly audioService: WhatsAppAudioTranscriptionService,
    private readonly documentService: WhatsAppDocumentExtractionService,
    private readonly videoService: WhatsAppVideoProcessingService,
    private readonly openaiClient: OpenAIClient,
    private readonly queueService: WhatsAppQueueService,
  ) {}

  onModuleInit(): void {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    const connection = buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');

    this.worker = new Worker<WhatsAppMediaJobPayload>(
      WHATSAPP_MEDIA_QUEUE,
      job => this.process(job),
      { connection, concurrency: wa?.mediaWorkerConcurrency ?? 4 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.warn(`Media job ${String(job?.id)} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<WhatsAppMediaJobPayload>): Promise<void> {
    const data = job.data;
    const row = await this.mediaRepo.findOne({ where: { id: data.mediaRowId } });
    if (!row) {
      this.logger.warn(`Media row ${data.mediaRowId} not found — skipping`);
      return;
    }

    try {
      await this.mediaRepo.update(row.id, { status: WhatsAppMediaProcessingStatus.PROCESSING });
      await this.runPipeline(row, data);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`Media processing failed for ${row.id} (${data.mediaType}): ${message}`);
      await this.mediaRepo.update(row.id, {
        status: WhatsAppMediaProcessingStatus.FAILED,
        errorMessage: message.slice(0, 2000),
        processedAt: new Date(),
      });
    } finally {
      // Always let the conversation continue — a media hiccup should never block the AI reply.
      await this.queueService.enqueue({
        jobType: WhatsAppJobType.INBOUND_REPLY,
        conversationId: data.conversationId,
        payload: {
          inboundWamid: data.inboundWamid,
          userText: data.userText,
          metaPhoneNumberId: data.metaPhoneNumberId,
          companyId: data.companyId,
          mediaRowId: data.mediaRowId,
        },
        priority: 100,
        dedupeKey: `inbound_reply:${data.conversationId}`,
      });
    }
  }

  private async runPipeline(
    row: WhatsAppMessageMedia,
    data: WhatsAppMediaJobPayload,
  ): Promise<void> {
    if (
      data.mediaType === WhatsAppMediaKind.LOCATION ||
      data.mediaType === WhatsAppMediaKind.CONTACT
    ) {
      await this.processStructured(row, data);
      return;
    }

    if (!data.metaMediaId) {
      throw new Error(`Media job for ${data.mediaType} is missing metaMediaId`);
    }

    const companyConfig = await this.waConfigService.getActiveConfigOrThrow(data.companyId);
    const client = this.waConfigService.createMetaClient(companyConfig);
    const downloaded = await client.downloadInboundMedia(data.metaMediaId);

    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const folderPrefix = (wa?.mediaFolderPrefix ?? 'whatsapp-media/').replace(/\/+$/, '');
    const s3Prefix = `${folderPrefix}/${data.companyId}/${data.conversationId}`;
    let s3Result: { fileUrl: string; key: string } | null = null;
    try {
      s3Result = await this.s3Service.uploadMedia(
        downloaded.buffer,
        downloaded.mimeType,
        downloaded.filename,
        s3Prefix,
        wa?.mediaBucketName,
      );
    } catch (err) {
      this.logger.warn(
        `S3 upload failed for media ${row.id}, continuing without storage: ${(err as Error).message}`,
      );
    }

    await this.mediaRepo.update(row.id, {
      mimeType: downloaded.mimeType,
      sha256: downloaded.sha256 ?? null,
      fileSizeBytes: downloaded.buffer.length,
      s3Key: s3Result?.key ?? null,
      s3Url: s3Result?.fileUrl ?? null,
    });

    switch (data.mediaType) {
      case WhatsAppMediaKind.IMAGE:
        await this.processImage(row, downloaded.buffer, downloaded.mimeType, data.caption);
        break;
      case WhatsAppMediaKind.STICKER:
        await this.processSticker(row, downloaded.buffer, downloaded.mimeType);
        break;
      case WhatsAppMediaKind.AUDIO:
        await this.processAudio(row, downloaded.buffer, downloaded.filename, downloaded.mimeType);
        break;
      case WhatsAppMediaKind.VIDEO:
        await this.processVideo(row, downloaded.buffer);
        break;
      case WhatsAppMediaKind.DOCUMENT:
        await this.processDocument(
          row,
          downloaded.buffer,
          downloaded.mimeType,
          data.filename ?? downloaded.filename,
        );
        break;
      default:
        await this.markUnsupported(row, `Unhandled media type: ${String(data.mediaType)}`);
    }
  }

  private async processImage(
    row: WhatsAppMessageMedia,
    buffer: Buffer,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    const analysis = await this.visionService.analyzeImage(buffer, mimeType, caption);
    await this.finalize(row, {
      visionDescription: analysis.description,
      ocrText: analysis.ocrText,
      detectedObjects: analysis.objects,
      entities: analysis.entities,
      sceneSummary: analysis.summary,
    });
  }

  private async processSticker(
    row: WhatsAppMessageMedia,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    try {
      const analysis = await this.visionService.analyzeImage(buffer, mimeType);
      await this.finalize(row, {
        visionDescription: analysis.description,
        ocrText: analysis.ocrText,
        detectedObjects: analysis.objects,
        entities: analysis.entities,
        sceneSummary: analysis.summary,
      });
    } catch (err) {
      // Animated stickers in particular may not be analyzable by the vision model — acceptable limitation.
      await this.markUnsupported(row, `Sticker could not be analyzed: ${(err as Error).message}`);
    }
  }

  private async processAudio(
    row: WhatsAppMessageMedia,
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<void> {
    const transcript = await this.audioService.transcribe(buffer, filename, mimeType);
    await this.finalize(row, { transcript });
  }

  private async processVideo(row: WhatsAppMessageMedia, buffer: Buffer): Promise<void> {
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const maxDuration = wa?.mediaMaxVideoDurationSeconds ?? 180;

    const result = await this.videoService.process(buffer, maxDuration);

    if (result.skippedTooLong) {
      await this.markUnsupported(
        row,
        `Video is ${String(result.durationSeconds)}s, exceeding the ${String(maxDuration)}s processing limit`,
      );
      return;
    }

    const frameAnalyses: ImageAnalysis[] = [];
    for (const frame of result.frames) {
      try {
        frameAnalyses.push(await this.visionService.analyzeImage(frame.buffer, 'image/jpeg'));
      } catch (err) {
        this.logger.debug(
          `Skipping unreadable video frame at ${String(frame.atSeconds)}s: ${(err as Error).message}`,
        );
      }
    }

    const merged =
      frameAnalyses.length > 0
        ? this.visionService.mergeFrameAnalyses(frameAnalyses)
        : { description: '', sceneSummary: '', objects: [] as string[], entities: [] as string[] };

    let transcript: string | undefined;
    if (result.audioBuffer) {
      try {
        transcript = await this.audioService.transcribe(
          result.audioBuffer,
          'audio.mp3',
          'audio/mpeg',
        );
      } catch (err) {
        this.logger.warn(
          `Video audio transcription failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.finalize(row, {
      durationSeconds: result.durationSeconds,
      visionDescription: merged.description || null,
      sceneSummary: merged.sceneSummary || null,
      detectedObjects: merged.objects,
      entities: merged.entities,
      transcript: transcript ?? null,
    });
  }

  private async processDocument(
    row: WhatsAppMessageMedia,
    buffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<void> {
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const maxBytes = wa?.mediaMaxDocumentBytes ?? 25 * 1024 * 1024;

    if (buffer.length > maxBytes) {
      await this.markUnsupported(
        row,
        `Document is ${String(buffer.length)} bytes, exceeding the ${String(maxBytes)} byte limit`,
      );
      return;
    }
    if (!this.documentService.isSupported(mimeType, filename)) {
      await this.markUnsupported(row, `Unsupported document type: ${mimeType} (${filename})`);
      return;
    }

    const { extractedText, pageCount } = await this.documentService.extract(
      buffer,
      mimeType,
      filename,
    );
    await this.finalize(row, { extractedText, pageCount });
  }

  private async processStructured(
    row: WhatsAppMessageMedia,
    data: WhatsAppMediaJobPayload,
  ): Promise<void> {
    const structuredData = data.structuredData ?? null;
    const summary = this.describeStructuredData(data.mediaType, structuredData);
    await this.finalize(row, { structuredData, sceneSummary: summary });
  }

  private describeStructuredData(
    mediaType: WhatsAppMediaKind,
    data: WhatsAppMessageMedia['structuredData'],
  ): string {
    if (mediaType === WhatsAppMediaKind.LOCATION && data?.location) {
      const { name, address, latitude, longitude } = data.location;
      return `Shared location: ${[name, address].filter(Boolean).join(', ') || `${String(latitude)}, ${String(longitude)}`}`;
    }
    if (mediaType === WhatsAppMediaKind.CONTACT && data?.contacts?.length) {
      return data.contacts
        .map(
          c =>
            `Shared contact: ${c.name ?? 'Unknown'}${c.phones?.length ? ` — ${c.phones.join(', ')}` : ''}`,
        )
        .join('; ');
    }
    return '';
  }

  private async markUnsupported(row: WhatsAppMessageMedia, reason: string): Promise<void> {
    this.logger.warn(`Media ${row.id} marked unsupported: ${reason}`);
    await this.mediaRepo.update(row.id, {
      status: WhatsAppMediaProcessingStatus.UNSUPPORTED,
      errorMessage: reason.slice(0, 2000),
      processedAt: new Date(),
    });
  }

  private async finalize(
    row: WhatsAppMessageMedia,
    fields: Partial<
      Pick<
        WhatsAppMessageMedia,
        | 'visionDescription'
        | 'ocrText'
        | 'detectedObjects'
        | 'entities'
        | 'sceneSummary'
        | 'transcript'
        | 'extractedText'
        | 'structuredData'
        | 'durationSeconds'
        | 'pageCount'
      >
    >,
  ): Promise<void> {
    const combinedText = [
      fields.sceneSummary,
      fields.visionDescription,
      fields.ocrText,
      fields.transcript,
      fields.extractedText,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_EMBEDDING_INPUT_CHARS);

    let embedding: number[] | null = null;
    let embeddingModel: string | null = null;
    if (combinedText.trim()) {
      try {
        const result = await this.openaiClient.createEmbedding(combinedText);
        embedding = result.embedding;
        embeddingModel = result.model;
      } catch (err) {
        this.logger.warn(
          `Embedding generation failed for media ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.mediaRepo.update(row.id, {
      ...fields,
      embedding,
      embeddingModel,
      status: WhatsAppMediaProcessingStatus.COMPLETED,
      processedAt: new Date(),
    });
  }
}
