import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';
import { Company } from '../companies/company.entity';

@Entity('whatsapp_inbound_config')
export class WhatsAppInboundConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 64 })
  metaPhoneNumberId: string;

  @Column({ type: 'varchar', length: 32, default: WhatsAppRoutingMode.AI })
  routingMode: WhatsAppRoutingMode;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  flowId: string | null;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  @Column({ type: 'varchar', length: 64, default: 'gpt-4o-mini' })
  aiModel: string;

  @Column({ type: 'text', nullable: true })
  aiSystemPrompt: string | null;

  @Column({ type: 'boolean', default: true })
  sendGreetingOnFirstMessage: boolean;

  @Column({ type: 'boolean', default: true })
  markInboundAsRead: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
