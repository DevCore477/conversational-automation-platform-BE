import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { WhatsAppCampaignStatus } from '../../common/enums/whatsapp.enum';
import { Company } from '../companies/company.entity';
import { WhatsAppTemplate } from './whatsapp-template.entity';

@Entity('whatsapp_campaigns')
export class WhatsAppCampaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 24, default: WhatsAppCampaignStatus.QUEUED })
  status: WhatsAppCampaignStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  designType: string | null;

  @Column({ type: 'uuid', nullable: true })
  templateId: string | null;

  @ManyToOne(() => WhatsAppTemplate, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'templateId' })
  template?: WhatsAppTemplate;

  /** Per-campaign template placeholder mapping (e.g. {"1":"{{name}}"}). */
  @Column({ type: 'jsonb', nullable: true })
  templateVariableMapping: Record<string, string> | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'text', nullable: true })
  pauseReason: string | null;

  @Column({ type: 'int', default: 0 })
  totalCount: number;

  @Column({ type: 'int', default: 0 })
  queuedCount: number;

  @Column({ type: 'int', default: 0 })
  sentCount: number;

  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @Column({ type: 'int', default: 0 })
  deliveredCount: number;

  @Column({ type: 'int', default: 0 })
  readCount: number;

  @Column({ type: 'int', default: 0 })
  skippedCount: number;

  @Column({ type: 'boolean', default: false })
  dryRun: boolean;

  /** Reply routing when recipients respond to this campaign (overrides global inbound config). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  routingMode: string | null;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  flowId: string | null;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  aiModel: string | null;

  @Column({ type: 'text', nullable: true })
  aiSystemPrompt: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
