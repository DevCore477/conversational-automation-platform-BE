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

@Entity('call_scripts')
export class CallScript {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text' })
  script: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  firstMessage: string;

  @Column({ type: 'varchar', length: 50, default: 'gpt-4' })
  model: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  voiceId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'both' })
  callType: 'inbound' | 'outbound' | 'both';

  @Column({ type: 'boolean', default: false })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  // Usage statistics
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
}
