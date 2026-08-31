import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Hexa AI's own connected LinkedIn Company Page — this is a single global integration
 * (the website's blog feed), not a per-tenant/customer connection. Singleton row keyed by
 * a fixed id, same pattern as WhatsAppMetaToken.
 * Tokens are stored encrypted at rest (see token-crypto.util) — never log or return them raw.
 */
@Entity('linkedin_organizations')
export class LinkedInOrganization {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  /** e.g. "urn:li:organization:12345" — the only accepted author for fetched posts. */
  @Column({ type: 'varchar', length: 255 })
  organizationUrn: string;

  /** Numeric LinkedIn company id extracted from organizationUrn, kept for quick lookups. */
  @Column({ type: 'varchar', length: 64 })
  organizationId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  organizationName: string | null;

  /** AES-256-GCM ciphertext ("v1:iv:tag:data"); plaintext only if LINKEDIN_TOKEN_ENCRYPTION_KEY unset. */
  @Column({ type: 'text' })
  accessTokenEncrypted: string;

  @Column({ type: 'text', nullable: true })
  refreshTokenEncrypted: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  scope: string | null;

  @Column({ type: 'timestamptz' })
  accessTokenExpiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  refreshTokenExpiresAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  connectedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt: Date | null;

  /** Set (with a reason in lastSyncError) when the stored token is rejected and needs reconnect. */
  @Column({ type: 'boolean', default: false })
  needsReconnect: boolean;

  @Column({ type: 'text', nullable: true })
  lastSyncError: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
