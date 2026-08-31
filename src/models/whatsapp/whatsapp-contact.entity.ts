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

@Entity('whatsapp_contacts')
export class WhatsAppContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 32 })
  phoneNumber: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'boolean', default: false })
  whatsappOptIn: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true })
  whatsappOptInSource: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  whatsappOptInAt: Date | null;

  @Column({ type: 'boolean', default: false })
  whatsappUnsubscribed: boolean;

  @Column({ type: 'boolean', default: false })
  whatsappBlocked: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
