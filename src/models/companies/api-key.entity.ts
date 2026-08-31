import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import type { ApiKeyPermissionsShape } from '../../api-keys/api-key-permissions.types';
import { Company } from './company.entity';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'companyId' })
  company: Company;

  @Column({ type: 'varchar', length: 100 })
  name: string; // Friendly name for the key

  @Column({ type: 'varchar', length: 64, unique: true })
  key: string; // The actual API key (hashed)

  @Column({ type: 'varchar', length: 16, unique: true })
  keyPrefix: string; // First 16 chars for display (e.g., "sk_live_abc123...")

  @Column({ type: 'text', nullable: true })
  description: string;

  // Permissions
  @Column({ type: 'jsonb', default: {} })
  permissions: ApiKeyPermissionsShape;

  // Restrictions
  @Column({ type: 'jsonb', nullable: true })
  restrictions: {
    ipWhitelist?: string[]; // Array of allowed IPs
    rateLimit?: number; // Requests per minute
    allowedOrigins?: string[]; // CORS origins
  } | null;

  // Usage tracking
  @Column({ type: 'integer', default: 0 })
  totalRequests: number;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastUsedIp: string | null;

  // Status
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string; // User ID who created the key

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
