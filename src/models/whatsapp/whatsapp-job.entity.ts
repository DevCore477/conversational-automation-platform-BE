import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { WhatsAppJobStatus, WhatsAppJobType } from '../../common/enums/whatsapp.enum';
import { WhatsAppCampaign } from './whatsapp-campaign.entity';
import { WhatsAppConversation } from './whatsapp-conversation.entity';

@Entity('whatsapp_jobs')
export class WhatsAppJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  jobType: WhatsAppJobType;

  @Column({ type: 'varchar', length: 24, default: WhatsAppJobStatus.PENDING })
  status: WhatsAppJobStatus;

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @ManyToOne(() => WhatsAppConversation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'conversationId' })
  conversation?: WhatsAppConversation;

  @Column({ type: 'uuid', nullable: true })
  campaignId: string | null;

  @ManyToOne(() => WhatsAppCampaign, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'campaignId' })
  campaign?: WhatsAppCampaign;

  @Column({ type: 'varchar', length: 128, nullable: true })
  dedupeKey: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 5 })
  maxAttempts: number;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  scheduledAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lockedBy: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
