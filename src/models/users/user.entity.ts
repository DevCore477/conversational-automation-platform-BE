import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserRole, CompanyUserStatus } from '../../common/enums';
import { Company } from '../companies/company.entity';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'first_name', length: 80 })
  firstName: string;

  @Column({ name: 'last_name', length: 80 })
  lastName: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.MEMBER,
  })
  role: UserRole;

  // Company relationship
  @Column({ name: 'company_id', nullable: true })
  companyId?: string | null;

  @ManyToOne(() => Company, company => company.users, { nullable: true })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  @Column({ name: 'company_role', length: 50, default: 'user' })
  companyRole: string; // owner, admin, user

  @Column({
    name: 'company_status',
    type: 'enum',
    enum: CompanyUserStatus,
    nullable: true,
    default: CompanyUserStatus.ACTIVE,
  })
  companyStatus?: CompanyUserStatus;

  @Column({ name: 'invited_by', nullable: true })
  invitedById?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'invited_by' })
  invitedBy?: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
