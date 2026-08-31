import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Single-row cache for Meta Graph API access token (id = 'default'). */
@Entity('whatsapp_meta_token')
export class WhatsAppMetaToken {
  @PrimaryColumn({ type: 'varchar', length: 32, default: 'default' })
  id: string;

  @Column({ type: 'text' })
  accessToken: string;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
