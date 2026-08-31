import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '../companies/company.entity';

@Entity('whatsapp_template_library_cache')
export class WhatsAppTemplateLibraryCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 512 })
  searchKey: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  language: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  topic: string | null;

  @Column({ type: 'jsonb' })
  resultJson: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
