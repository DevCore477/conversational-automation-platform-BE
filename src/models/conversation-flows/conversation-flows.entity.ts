import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import * as flowsTypes from '../../flows/types/flows.types';

@Entity('conversation_flows')
export class ConversationFlow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null; // optional link to CallScript

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: 'draft' | 'published' | 'archived';

  @Column({ type: 'int', default: 1 })
  version: number;

  /**
   * 🔑 The heart of the system
   */
  @Column({ type: 'jsonb' })
  flow!: flowsTypes.ConversationFlowJSON;

  @Column({ type: 'timestamp', nullable: true })
  publishedAt: Date | null;

  /** Usage statistics (mirrors call_scripts usage tracking) */
  @Column({ type: 'integer', default: 0 })
  totalCalls: number;

  @Column({ type: 'integer', default: 0 })
  successfulCalls: number;

  @Column({ type: 'integer', default: 0 })
  failedCalls: number;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn({ nullable: true, type: 'timestamptz' })
  deletedAt: Date | null;
}
