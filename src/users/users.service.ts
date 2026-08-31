import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';

import { CompanyUserStatus, UserRole } from '../common/enums';
import { User } from '../models/users/user.entity';
import { Invitation } from '../models/users/invitation.entity';
import { PasswordResetToken } from '../models/users/password-reset-token.entity';
import { Company } from '../models/companies/company.entity';

interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
  role?: UserRole;
  invitedById?: string;
  companyId?: string;
  companyRole?: string;
}

export interface UpdateUserPlatformInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: UserRole;
}

/** Safe subset of {@link User} for JSON responses (no password hash or relations). */
export interface SanitizedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  companyId: string | null | undefined;
  companyRole: string;
  companyStatus?: CompanyUserStatus;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetTokenRepository: Repository<PasswordResetToken>,
  ) {}

  async countUsers(): Promise<number> {
    return this.usersRepository.count();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const existing = await this.findByEmail(input.email);
    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }

    const user = this.usersRepository.create({
      email: input.email.toLowerCase(),
      firstName: input.firstName,
      lastName: input.lastName,
      passwordHash: input.passwordHash,
      role: input.role ?? UserRole.MEMBER,
      invitedById: input.invitedById,
      companyId: input.companyId ?? undefined,
      companyRole: input.companyRole ?? undefined,
    });

    return this.usersRepository.save(user);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const user = await this.findById(userId);
    user.passwordHash = passwordHash;
    await this.usersRepository.save(user);
  }

  /**
   * Update platform user info (admin only). Email must remain unique.
   */
  async updateUser(id: string, input: UpdateUserPlatformInput): Promise<User> {
    const user = await this.findById(id);
    if (input.firstName != null) user.firstName = input.firstName;
    if (input.lastName != null) user.lastName = input.lastName;
    if (input.role != null) user.role = input.role;
    if (input.email != null) {
      const existing = await this.findByEmail(input.email.toLowerCase());
      if (existing && existing.id !== id) {
        throw new BadRequestException('A user with this email already exists');
      }
      user.email = input.email.toLowerCase();
    }
    return this.usersRepository.save(user);
  }

  /**
   * Delete user from platform (admin only). Clears invitation references and company count.
   */
  async deleteUser(id: string): Promise<void> {
    try {
      const user = await this.usersRepository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (user.companyId) {
        await this.companyRepository.decrement({ id: user.companyId }, 'totalUsers', 1);
      }
      await this.invitationRepository.query(
        'UPDATE invitations SET invited_by = NULL WHERE invited_by = $1',
        [id],
      );
      await this.passwordResetTokenRepository.delete({ userId: id });

      await this.usersRepository.delete(user.id);
    } catch (error) {
      throw new BadRequestException(`Failed to delete user: ${String(error)}`);
    }
  }

  sanitize(user: User): SanitizedUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      companyId: user.companyId,
      companyRole: user.companyRole,
      companyStatus: user.companyStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private applyMembersSearchFilter(queryBuilder: SelectQueryBuilder<User>, search?: string): void {
    if (!search) {
      return;
    }
    queryBuilder.andWhere(
      new Brackets(qb => {
        qb.where('LOWER(user.email) LIKE LOWER(:search)', {
          search: `%${search}%`,
        })
          .orWhere('LOWER(user.firstName) LIKE LOWER(:search)', {
            search: `%${search}%`,
          })
          .orWhere('LOWER(user.lastName) LIKE LOWER(:search)', {
            search: `%${search}%`,
          })
          .orWhere("LOWER(CONCAT(user.firstName, ' ', user.lastName)) LIKE LOWER(:search)", {
            search: `%${search}%`,
          });
      }),
    );
  }

  /**
   * Role / company breakdown for the members list. Uses the same `search` as the list; ignores `role` filter.
   */
  async getMembersListCounts(search?: string): Promise<{
    matchingSearchTotal: number;
    platformAdmin: number;
    platformMember: number;
    withCompany: number;
    withoutCompany: number;
  }> {
    const base = this.usersRepository.createQueryBuilder('user');
    this.applyMembersSearchFilter(base, search);

    const matchingSearchTotal = await base.clone().getCount();

    const platformAdmin = await base
      .clone()
      .andWhere('user.role = :role', { role: UserRole.ADMIN })
      .getCount();

    const platformMember = await base
      .clone()
      .andWhere('user.role = :role', { role: UserRole.MEMBER })
      .getCount();

    const withCompany = await base.clone().andWhere('user.companyId IS NOT NULL').getCount();

    const withoutCompany = await base.clone().andWhere('user.companyId IS NULL').getCount();

    return {
      matchingSearchTotal,
      platformAdmin,
      platformMember,
      withCompany,
      withoutCompany,
    };
  }

  async getMembersPaginated(
    page: number,
    limit: number,
    search?: string,
    role?: UserRole,
    companyId?: string,
    sortBy: 'createdAt' | 'email' | 'firstName' | 'lastName' = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): Promise<{
    users: User[];
    total: number;
    counts: {
      matchingSearchTotal: number;
      platformAdmin: number;
      platformMember: number;
      withCompany: number;
      withoutCompany: number;
    };
  }> {
    const skip = (page - 1) * limit;

    const [listResult, counts] = await Promise.all([
      (async () => {
        const queryBuilder = this.usersRepository
          .createQueryBuilder('user')
          .select([
            'user.id',
            'user.email',
            'user.firstName',
            'user.lastName',
            'user.role',
            'user.createdAt',
            'user.updatedAt',
            'user.companyId',
            'user.companyRole',
            'company.name',
          ])
          .leftJoinAndSelect('user.company', 'company');

        if (role) {
          queryBuilder.where('user.role = :role', { role });
        }

        if (companyId) {
          queryBuilder.andWhere('user.companyId = :companyId', { companyId });
        }

        this.applyMembersSearchFilter(queryBuilder, search);

        queryBuilder.orderBy(`user.${sortBy}`, sortOrder);
        queryBuilder.skip(skip).take(limit);

        return queryBuilder.getManyAndCount();
      })(),
      this.getMembersListCounts(search),
    ]);

    const [users, total] = listResult;

    return { users, total, counts };
  }
}
