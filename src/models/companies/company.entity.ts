import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';

import { User } from '../users/user.entity';

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200, unique: true })
  name: string;

  @Column({ type: 'varchar', length: 200, unique: true })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  website: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry: string;

  // Theme and Branding
  @Column({ type: 'varchar', length: 255, nullable: true })
  logo?: string | null; // URL to logo

  @Column({ type: 'varchar', length: 255, nullable: true })
  icon?: string; // URL to icon/favicon

  @Column({ type: 'varchar', length: 20, default: '#3B82F6' })
  primaryColor: string;

  @Column({ type: 'varchar', length: 20, default: '#1E40AF' })
  secondaryColor: string;

  // Contact Information
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'text', nullable: true })
  address: string;

  // Settings
  @Column({ type: 'jsonb', nullable: true })
  settings: {
    timezone?: string;
    dateFormat?: string;
    currency?: string;
    language?: string;
    maxUsers?: number;
    maxCallsPerMonth?: number;
    features?: {
      inboundCalls?: boolean;
      outboundCalls?: boolean;
      voiceAgent?: boolean;
      callRecording?: boolean;
      callAnalytics?: boolean;
      apiAccess?: boolean;
    };
    notifications?: {
      email?: boolean;
      sms?: boolean;
      webhook?: boolean;
    };
    integrations?: {
      twilioAccountSid?: string;
      twilioAuthToken?: string;
      elevenlabsApiKey?: string;
      openaiApiKey?: string;
    };
    inboundPhoneNumbers?: string[];
    vetClinic?: {
      doctorNames?: string;
      alternateWeekendSlots?: string;
    };
  };

  // Subscription/Plan
  @Column({ type: 'varchar', length: 50, default: 'free' })
  plan: string; // free, starter, professional, enterprise

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  subscriptionEndsAt: Date | null;

  // Usage tracking
  @Column({ type: 'integer', default: 0 })
  callsThisMonth: number;

  @Column({ type: 'integer', default: 0 })
  totalCalls: number;

  @Column({ type: 'integer', default: 0 })
  totalUsers: number;

  // Relations
  @OneToMany(() => User, user => user.company)
  users: User[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
