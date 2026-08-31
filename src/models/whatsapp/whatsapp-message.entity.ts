import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { WhatsAppMessageDirection, WhatsAppMessageStatus } from '../../common/enums/whatsapp.enum';
import { Company } from '../companies/company.entity';
import { WhatsAppContact } from './whatsapp-contact.entity';
import { WhatsAppConversation } from './whatsapp-conversation.entity';
import { WhatsAppCampaign } from './whatsapp-campaign.entity';

@Entity('whatsapp_messages')
export class WhatsAppMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'uuid', nullable: true })
  contactId: string | null;

  @ManyToOne(() => WhatsAppContact, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'contactId' })
  contact?: WhatsAppContact;

  @Column({ type: 'uuid', nullable: true })
  campaignId: string | null;

  @ManyToOne(() => WhatsAppCampaign, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'campaignId' })
  campaign?: WhatsAppCampaign;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phoneNumber: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  templateName: string | null;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => WhatsAppConversation, c => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation?: WhatsAppConversation;

  @Column({ type: 'varchar', length: 16 })
  direction: WhatsAppMessageDirection;

  @Column({ type: 'varchar', length: 32, default: 'text' })
  messageType: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'text', nullable: true })
  mediaUrl: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  metaWamid: string | null;

  @Column({ type: 'varchar', length: 24, default: WhatsAppMessageStatus.RECEIVED })
  status: WhatsAppMessageStatus;

  @Column({ type: 'timestamptz', nullable: true })
  statusUpdatedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  /** Set when removed from inbox UI — retained for campaign reporting and audit. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
