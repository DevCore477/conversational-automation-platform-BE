import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  WhatsAppMediaKind,
  WhatsAppMediaProcessingStatus,
} from '../../common/enums/whatsapp.enum';
import { WhatsAppMessage } from './whatsapp-message.entity';

/** Structured location/contact payload extracted from the Meta webhook (no download needed). */
export interface WhatsAppMediaStructuredData {
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  contacts?: Array<{
    name?: string;
    phones?: string[];
  }>;
}

/**
 * One row per media/structured-content message. Kept as its own table (rather than columns on
 * the hot `whatsapp_messages` table) to isolate migration risk and keep the pipeline modular.
 */
@Entity('whatsapp_message_media')
export class WhatsAppMessageMedia {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  messageId: string;

  @ManyToOne(() => WhatsAppMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'messageId' })
  message?: WhatsAppMessage;

  @Index()
  @Column({ type: 'uuid' })
  conversationId: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @Column({ type: 'varchar', length: 16 })
  mediaType: WhatsAppMediaKind;

  @Column({ type: 'varchar', length: 128, nullable: true })
  metaMediaId: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  mimeType: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  sha256: string | null;

  @Column({ type: 'bigint', nullable: true })
  fileSizeBytes: number | null;

  @Column({ type: 'text', nullable: true })
  s3Key: string | null;

  @Column({ type: 'text', nullable: true })
  s3Url: string | null;

  @Index()
  @Column({ type: 'varchar', length: 16, default: WhatsAppMediaProcessingStatus.PENDING })
  status: WhatsAppMediaProcessingStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  /** Vision output (image / video frames). */
  @Column({ type: 'text', nullable: true })
  visionDescription: string | null;

  @Column({ type: 'text', nullable: true })
  ocrText: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detectedObjects: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  entities: string[] | null;

  @Column({ type: 'text', nullable: true })
  sceneSummary: string | null;

  /** Audio / video transcript. */
  @Column({ type: 'text', nullable: true })
  transcript: string | null;

  /** Document text extraction. */
  @Column({ type: 'text', nullable: true })
  extractedText: string | null;

  /** Location / contact payload. */
  @Column({ type: 'jsonb', nullable: true })
  structuredData: WhatsAppMediaStructuredData | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'int', nullable: true })
  pageCount: number | null;

  /** Embedding of the combined analyzed text, stored as a plain float array (no pgvector dependency). */
  @Column({ type: 'jsonb', nullable: true })
  embedding: number[] | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  embeddingModel: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
