import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../companies/company.entity';

@Entity('company_whatsapp_configs')
export class CompanyWhatsAppConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 16, default: 'meta' })
  provider: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  wabaId: string | null;

  @Column({ type: 'varchar', length: 64 })
  phoneNumberId: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  businessPhoneNumber: string | null;

  @Column({ type: 'text' })
  accessTokenEncrypted: string;

  @Column({ type: 'text', nullable: true })
  appSecretEncrypted: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookVerifyToken: string | null;

  @Column({ type: 'varchar', length: 16, default: 'v25.0' })
  apiVersion: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'int', nullable: true })
  maxMessagesPerSecond: number | null;

  @Column({ type: 'int', nullable: true })
  maxMessagesPerMinute: number | null;

  @Column({ type: 'int', nullable: true })
  maxDailyMessages: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  qualityStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  messagingTier: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
