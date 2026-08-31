import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Company } from '../companies/company.entity';
import type { CallTranscriptTurn } from './call-transcript.types';

@Entity('call_records')
export class CallRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 100, unique: true })
  callSid: string;

  @Column({ type: 'varchar', length: 20 })
  status: string; // initiating, active, completed, failed

  @Column({ type: 'varchar', length: 50 })
  phoneNumberFrom: string;

  @Column({ type: 'varchar', length: 50 })
  phoneNumberTo: string;

  @Column({ type: 'text' })
  script: string;

  @Column({ type: 'varchar', length: 50 })
  model: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  provider: string | null;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  scriptName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  callType: string | null; // inbound, outbound

  @Column({ type: 'integer', nullable: true })
  duration: number | null; // in seconds

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  /** User and agent utterances for this call (populated during / at end of the call). */
  @Column({ type: 'jsonb', nullable: true, name: 'conversation_transcript' })
  conversationTranscript: CallTranscriptTurn[] | null;

  // Retry tracking
  @Column({ type: 'integer', default: 0 })
  retryAttempts: number;

  @Column({ type: 'integer', default: 3 })
  maxRetryAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  nextRetryAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRetryAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;
}
