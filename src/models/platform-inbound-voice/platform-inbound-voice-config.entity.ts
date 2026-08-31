import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Two kinds of rows, distinguished by `phoneNumber`:
 *
 * - `phoneNumber IS NULL` — the legacy single platform-default row, used for inbound Telnyx/Twilio
 *   calls when the called number doesn't map to anything more specific. At most one such row is
 *   maintained by `PlatformInboundVoiceService.getConfig()`/`upsert()`.
 * - `phoneNumber` set — a per-company Telnyx DID (unique across rows). Inbound calls to this
 *   number resolve via this row's `routingMode`/`agentId`/`flowId`/`scriptId`; outbound calls
 *   placed on behalf of `platformCompanyId` use this number as the Telnyx caller ID. See
 *   `PlatformInboundVoiceService.tryResolveByPhoneNumber` / `resolveOutboundNumber`.
 *
 * Choose exactly one routing strategy via routingMode + the matching FK (agent / flow / script),
 * or database_default to fall through to the next resolution tier (legacy "default inbound" call
 * script for the null row; company-by-phone / platform fallback for a numbered row).
 */
@Entity('platform_inbound_voice_config')
export class PlatformInboundVoiceConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Optional tenant scope. When null, routing is global: resolve agent/flow/script by ID only
   * (published flow anywhere in the DB). When set, flow mode may also resolve by (flowId + companyId).
   * Required (enforced at the DTO/service layer, not the DB) for numbered rows, since a Telnyx
   * number with no owning company can't be resolved for outbound calls.
   */
  @Column({ type: 'uuid', nullable: true })
  platformCompanyId: string | null;

  @Column({ type: 'varchar', length: 32, default: 'database_default' })
  routingMode: 'agent' | 'flow' | 'script' | 'database_default';

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  flowId: string | null;

  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  /**
   * E.164 Telnyx DID owned by `platformCompanyId`. NULL for the legacy platform-default row.
   * Unique among non-null values (partial unique index — see the companion migration SQL).
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phoneNumber: string | null;

  /** Soft-disable a numbered row without deleting it. Ignored for the phoneNumber-null row. */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
