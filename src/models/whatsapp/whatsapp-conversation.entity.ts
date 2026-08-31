import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../companies/company.entity';
import { WhatsAppMessage } from './whatsapp-message.entity';

export interface WhatsAppSessionState {
  routingMode?: string;
  agentId?: string;
  flowId?: string;
  scriptId?: string;
  model?: string;
  systemPrompt?: string;
  agentGlobalPrompt?: string;
  conversationFlowMode?: string;
  flowState?: {
    currentNode: string;
    slots: Record<string, unknown>;
    history: { role: 'agent' | 'user'; text: string; at: string }[];
    turnContext?: Record<string, unknown>;
  };
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[];
}

@Entity('whatsapp_conversations')
export class WhatsAppConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 32 })
  contactPhone: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  contactWaId: string | null;

  @Column({ type: 'varchar', length: 64 })
  metaPhoneNumberId: string;

  @Column({ type: 'uuid', nullable: true })
  contactId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  serviceWindowExpiresAt: Date | null;

  @Column({ type: 'boolean', default: true })
  aiEnabled: boolean;

  @Column({ type: 'uuid', nullable: true })
  assignedAgentId: string | null;

  @Column({ type: 'varchar', length: 24, default: 'open' })
  status: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  routingMode: string | null;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  flowId: string | null;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  sessionState: WhatsAppSessionState | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastInboundAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastOutboundAt: Date | null;

  /** Inbound messages from the customer not yet read by the business. */
  @Column({ type: 'int', name: 'unreadCount', default: 0 })
  unreadCount: number;

  /** Set when the inbox thread is cleared — hidden from lists, not removed from DB. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => WhatsAppMessage, m => m.conversation)
  messages?: WhatsAppMessage[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
