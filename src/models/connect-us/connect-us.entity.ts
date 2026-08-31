import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const CompanySizeEnum = ['1 - 10', '11 - 50', '51 - 100', '101 - 500', '500+'] as const;

export const UseCaseEnum = [
  "Use Hexa AI for my company's phone operations",
  'I want to help my clients implement AI voice agents',
  'Build a product for my customers',
  'Whitelabel and resell Hexa AI to my clients',
  'Become a Hexa AI certified partner',
] as const;

export const ImplementationEnum = [
  'Self-setup with my developers',
  'Managed service by Hexa AI',
  'Hybrid approach',
  'Need consulting',
] as const;

export const AgentsCountEnum = [
  'Fewer than 10',
  '10 - 50',
  '51 - 100',
  '101 - 500',
  '500+',
] as const;

export const StatusEnum = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'] as const;

@Entity('connect_us_submissions')
export class ConnectUsSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  firstName: string;

  @Column({ type: 'varchar', length: 100 })
  lastName: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  companySize: (typeof CompanySizeEnum)[number] | null;

  @Column({ type: 'text', nullable: true })
  useCase: (typeof UseCaseEnum)[number] | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  implementation: (typeof ImplementationEnum)[number] | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  agentsCount: (typeof AgentsCountEnum)[number] | null;

  @Column({ type: 'text', nullable: true })
  message: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  referralSource: string;

  @Column({ type: 'varchar', length: 50, default: 'New' })
  status: (typeof StatusEnum)[number];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
