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

@Entity('whatsapp_templates')
export class WhatsAppTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'varchar', length: 128 })
  metaTemplateName: string;

  /** Meta Graph template id (from sync) */
  @Column({ type: 'varchar', length: 64, nullable: true })
  metaTemplateId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 16, default: 'en' })
  language: string;

  @Column({ type: 'varchar', length: 32, default: 'approved' })
  status: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  qualityStatus: string | null;

  @Column({ type: 'jsonb', nullable: true })
  components: Record<string, unknown>[] | null;

  /** Human-readable preview extracted from BODY component */
  @Column({ type: 'text', nullable: true })
  bodyPreview: string | null;

  @Column({ type: 'varchar', length: 24, default: 'synced' })
  source: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  libraryTemplateName: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
