import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';

import { UserRole, CompanyUserStatus } from '../common/enums';
import { CompanyRoles } from '../common/enums/company-roles.enum';
import authConfig from '../configs/auth.config';
import { EmailService } from '../email/email.service';
import { CallScript } from '../models/call-scripts/call-script.entity';
import { ApiKey } from '../models/companies/api-key.entity';
import { Company } from '../models/companies/company.entity';
import { Invitation } from '../models/users/invitation.entity';
import { User } from '../models/users/user.entity';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { Agent } from '../models/agents/agent.entity';
import { UsersService, type SanitizedUser } from '../users/users.service';
import {
  type CompanyWhatsAppStatus,
  WhatsAppConfigService,
} from '../whatsapp/services/whatsapp-config.service';
import { resolveCompanyMemberPermissions } from './utils/company-member-permissions.util';

export type CompanyWithWhatsAppStatus = Company & { whatsapp: CompanyWhatsAppStatus };

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(CallScript)
    private readonly callScriptRepository: Repository<CallScript>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(ConversationFlow)
    private readonly conversationFlowRepository: Repository<ConversationFlow>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    private readonly emailService: EmailService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly whatsappConfigService: WhatsAppConfigService,
  ) {}

  async attachWhatsAppStatus(company: Company): Promise<CompanyWithWhatsAppStatus> {
    return {
      ...company,
      whatsapp: await this.whatsappConfigService.getCompanyWhatsAppStatus(company.id),
    };
  }

  async findOneWithWhatsAppStatus(
    id: string,
    options: { allowInactive?: boolean; inactiveAsForbidden?: boolean } = {},
  ): Promise<CompanyWithWhatsAppStatus> {
    const company = await this.findOne(id, options);
    return this.attachWhatsAppStatus(company);
  }

  private get authConfig(): ConfigType<typeof authConfig> {
    return this.configService.getOrThrow<ConfigType<typeof authConfig>>('auth');
  }

  private get appBaseUrl() {
    return this.configService.get<string>('app.baseUrl') ?? 'http://localhost:3000';
  }

  /**
   * Create a new company
   */
  async create(data: {
    name: string;
    email: string;
    ownerId: string;
    description?: string;
    industry?: string;
    website?: string;
  }): Promise<Company> {
    // Check if company name already exists
    const existing = await this.companyRepository.findOne({
      where: { name: data.name },
    });

    if (existing) {
      throw new ConflictException(`A company with name "${data.name}" already exists`);
    }

    // Generate slug from name
    const slug = this.generateSlug(data.name);

    // Check if slug exists
    const slugExists = await this.companyRepository.findOne({
      where: { slug },
    });

    if (slugExists) {
      throw new ConflictException(`Company slug "${slug}" is already taken`);
    }

    // Create company
    const company = this.companyRepository.create({
      name: data.name,
      slug,
      email: data.email,
      description: data.description,
      website: data.website,
      industry: data.industry,
      plan: 'free',
      isActive: true,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days trial
      settings: {
        timezone: 'UTC',
        dateFormat: 'YYYY-MM-DD',
        currency: 'USD',
        language: 'en',
        maxUsers: 5, // Free plan limit
        maxCallsPerMonth: 100,
        features: {
          inboundCalls: true,
          outboundCalls: true,
          voiceAgent: true,
          callRecording: false,
          callAnalytics: true,
          apiAccess: false,
        },
        notifications: {
          email: true,
          sms: false,
          webhook: false,
        },
      },
    });

    const saved = await this.companyRepository.save(company);

    // Update owner user to belong to this company
    // await this.userRepository.update(data.ownerId, {
    //   companyId: saved.id,
    //   companyRole: 'admin',
    // });

    this.logger.log(`Created company: ${saved.name} (${saved.id})`);

    return saved;
  }

  /**
   * Get company by ID.
   * By default, deactivated companies are treated as missing (404), except when `allowInactive` is true (platform admin).
   * Use `inactiveAsForbidden: true` for authenticated tenant routes so clients get 403 with a clear message.
   */
  async findOne(
    id: string,
    options: { allowInactive?: boolean; inactiveAsForbidden?: boolean } = {},
  ): Promise<Company> {
    const allowInactive = options.allowInactive ?? false;
    const inactiveAsForbidden = options.inactiveAsForbidden ?? false;

    const company = await this.companyRepository.findOne({
      where: { id },
    });

    if (!company) {
      throw new NotFoundException(`Company with ID "${id}" not found`);
    }

    if (!allowInactive && !company.isActive) {
      if (inactiveAsForbidden) {
        throw new ForbiddenException(
          'This company has been deactivated. Contact your administrator or platform support.',
        );
      }
      throw new NotFoundException(`Company with ID "${id}" not found`);
    }

    return company;
  }

  /**
   * Get company by slug
   */
  async findBySlug(slug: string): Promise<Company> {
    const company = await this.companyRepository.findOne({
      where: { slug },
    });

    if (!company?.isActive) {
      throw new NotFoundException(`Company with slug "${slug}" not found`);
    }

    return company;
  }

  /**
   * Find company by inbound phone number (the number the caller is calling).
   * company.phone is used ONLY for this purpose (inbound number matching).
   * Also checks company.settings.inboundPhoneNumbers for multiple numbers per company.
   * Used to route inbound calls: called number → company → company's script.
   */
  async findByInboundPhone(calledNumber: string | null | undefined): Promise<Company | null> {
    const normalized = this.normalizePhone(calledNumber);
    if (!normalized) return null;

    const companies = await this.companyRepository.find({
      where: { isActive: true },
    });

    for (const company of companies) {
      if (company.phone && this.normalizePhone(company.phone) === normalized) {
        return company;
      }
      const inboundNumbers = company.settings.inboundPhoneNumbers ?? [];
      for (const num of inboundNumbers) {
        if (this.normalizePhone(num) === normalized) return company;
      }
    }
    return null;
  }

  private normalizePhone(raw: string | null | undefined): string {
    if (raw == null || typeof raw !== 'string') return '';
    const digits = raw.trim().replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }

  /**
   * List companies (platform admin). By default returns only active companies.
   * Pass `includeInactive: true` to include deactivated tenants.
   */
  async findAll(options: { includeInactive?: boolean } = {}): Promise<CompanyWithWhatsAppStatus[]> {
    const includeInactive = options.includeInactive ?? false;
    const companies = await this.companyRepository.find({
      where: includeInactive ? {} : { isActive: true },
      order: { createdAt: 'DESC' },
    });
    const companiesWithStatus: CompanyWithWhatsAppStatus[] = [];
    for (const company of companies) {
      companiesWithStatus.push(await this.attachWhatsAppStatus(company));
    }
    return companiesWithStatus;
  }

  /**
   * Update company
   */
  async update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      website: string;
      industry: string;
      email: string;
      phone: string;
      address: string;
      logo: string;
      icon: string;
      primaryColor: string;
      secondaryColor: string;
      settings: Company['settings'];
    }>,
    opts?: { allowInactive?: boolean },
  ): Promise<Company> {
    const company = await this.findOne(id, { allowInactive: opts?.allowInactive ?? false });

    // Check if new name conflicts
    if (data.name && data.name !== company.name) {
      const existing = await this.companyRepository.findOne({
        where: { name: data.name },
      });

      if (existing) {
        throw new ConflictException(`A company with name "${data.name}" already exists`);
      }

      // Update slug if name changed
      company.slug = this.generateSlug(data.name);
    }

    Object.assign(company, data);
    const updated = await this.companyRepository.save(company);

    this.logger.log(`Updated company: ${updated.name} (${updated.id})`);

    return updated;
  }

  /**
   * Update company settings
   */
  async updateSettings(
    id: string,
    settings: Partial<Company['settings']>,
    opts?: { allowInactive?: boolean },
  ): Promise<Company> {
    const company = await this.findOne(id, { allowInactive: opts?.allowInactive ?? false });

    company.settings = {
      ...company.settings,
      ...settings,
    };

    const updated = await this.companyRepository.save(company);

    this.logger.log(`Updated settings for company: ${updated.name}`);

    return updated;
  }

  /**
   * Update company theme
   */
  async updateTheme(
    id: string,
    theme: {
      logo?: string;
      icon?: string;
      primaryColor?: string;
      secondaryColor?: string;
    },
    opts?: { allowInactive?: boolean },
  ): Promise<Company> {
    const company = await this.findOne(id, { allowInactive: opts?.allowInactive ?? false });

    if (theme.logo !== '' && theme.logo !== undefined) {
      company.logo = theme.logo;
    } else {
      company.logo = null;
    }
    if (theme.icon) company.icon = theme.icon;
    if (theme.primaryColor) company.primaryColor = theme.primaryColor;
    if (theme.secondaryColor) company.secondaryColor = theme.secondaryColor;
    const updated = await this.companyRepository.save(company);

    this.logger.log(`Updated theme for company: ${updated.name}`);

    return updated;
  }

  /**
   * Update company plan
   */
  async updatePlan(
    id: string,
    plan: string,
    subscriptionEndsAt?: Date,
    opts?: { allowInactive?: boolean },
  ): Promise<Company> {
    const company = await this.findOne(id, { allowInactive: opts?.allowInactive ?? false });

    company.plan = plan;
    company.subscriptionEndsAt = subscriptionEndsAt ?? null;

    // Update limits based on plan
    const planLimits = this.getPlanLimits(plan);
    company.settings = {
      ...company.settings,
      ...planLimits,
    };

    const updated = await this.companyRepository.save(company);

    this.logger.log(`Updated plan for company ${updated.name} to: ${plan}`);

    return updated;
  }

  /**
   * Increment call count
   */
  async incrementCallCount(companyId: string): Promise<void> {
    await this.companyRepository.increment({ id: companyId }, 'callsThisMonth', 1);
    await this.companyRepository.increment({ id: companyId }, 'totalCalls', 1);
  }

  /**
   * Reset monthly call counts (called by cron)
   */
  @Cron('0 0 1 * *') // At 00:00 on day-of-month 1
  async resetMonthlyCallCounts(): Promise<void> {
    await this.companyRepository.updateAll({ callsThisMonth: 0 });
    this.logger.log('Reset monthly call counts for all companies');
  }

  /**
   * Delete company
   */
  async delete(id: string): Promise<void> {
    const company = await this.findOne(id, { allowInactive: true });

    await this.companyRepository.remove(company);

    this.logger.log(`Deleted company: ${company.name} (${id})`);
  }

  /**
   * Get company statistics
   */
  async getStats(companyId: string): Promise<{
    totalUsers: number;
    totalCalls: number;
    callsThisMonth: number;
    plan: string;
    isActive: boolean;
    activeAPIKeys: number;
    trialDaysLeft: number | null;
    totalScripts: number;
    totalFlows: number;
    totalAgents: number;
  }> {
    const company = await this.findOne(companyId, { inactiveAsForbidden: true });

    const trialDaysLeft = company.trialEndsAt
      ? Math.max(0, Math.ceil((company.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    const activeAPIKeys = await this.apiKeyRepository.count({
      where: { companyId, isActive: true },
    });

    const totalScripts = await this.callScriptRepository.count({
      where: { companyId },
    });

    const totalFlows = await this.conversationFlowRepository.count({
      where: { companyId },
    });

    const totalAgents = await this.agentRepository.count({
      where: { companyId },
    });

    return {
      totalUsers: company.totalUsers,
      totalCalls: company.totalCalls,
      callsThisMonth: company.callsThisMonth,
      plan: company.plan,
      isActive: company.isActive,
      activeAPIKeys,
      trialDaysLeft,
      totalScripts,
      totalFlows,
      totalAgents,
    };
  }

  /**
   * Generate URL-friendly slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Add user to company by email (creates invitation if user doesn't exist)
   */
  async addUserByEmail(
    companyId: string,
    email: string,
    companyRole: string,
    sendInviteEmail = true,
    invitedById?: string,
  ): Promise<{
    user?: SanitizedUser;
    invitationSent?: boolean;
    message: string;
  }> {
    const company = await this.findOne(companyId);

    // Check if user exists
    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    // Check user limit
    const maxUsers = company.settings.maxUsers ?? 5;
    if (maxUsers !== -1 && company.totalUsers >= maxUsers) {
      throw new BadRequestException(
        `Company has reached maximum user limit (${String(maxUsers)}). Upgrade plan to add more users.`,
      );
    }

    if (user) {
      // User exists - add them to company
      if (user.companyId && user.companyId !== companyId) {
        throw new BadRequestException(
          `User already belongs to another company. They must leave that company first.`,
        );
      }

      if (user.companyId === companyId) {
        return {
          user: this.usersService.sanitize(user),
          message: 'User is already a member of this company',
        };
      }

      // Add user to company
      user.companyId = companyId;
      user.companyRole = companyRole;
      user.companyStatus = CompanyUserStatus.ACTIVE;

      await this.userRepository.save(user);

      // Increment company user count
      await this.companyRepository.increment({ id: companyId }, 'totalUsers', 1);

      this.logger.log(
        `Added existing user ${user.email} to company ${company.name} as ${companyRole}`,
      );

      return {
        user: this.usersService.sanitize(user),
        message: 'User added to company successfully',
      };
    } else {
      if (sendInviteEmail) {
        // User doesn't exist - create invitation link
        if (invitedById == null) {
          throw new BadRequestException('invitedById is required');
        }
        const invitingUser = await this.userRepository.findOne({
          where: { id: invitedById },
        });
        if (!invitingUser) {
          throw new NotFoundException(`Inviting user not found`);
        }
        // if (invitingUser.companyRole !== UserRole.ADMIN && invitingUser.role !== UserRole.ADMIN) {
        //   throw new BadRequestException(
        //     'Only company admins and platform admins can invite new users',
        //   );
        // }

        const expiresInHours = this.authConfig.inviteExpiresHours;
        const expiresAt = this.addHoursToDate(new Date(), expiresInHours);
        const token = this.generateToken();

        const invitation = this.invitationRepository.create({
          email: email.toLowerCase(),
          token,
          role: UserRole.MEMBER,
          companyRole: this.resolveInvitationCompanyRole(companyRole),
          companyId,
          invitedById,
          expiresAt,
        });
        await this.invitationRepository.save(invitation);

        const link = `${this.authConfig.frontendBaseUrl ?? this.appBaseUrl}/accept-invite?token=${token}&companyId=${companyId}`;
        this.logger.debug(`Invitation link generated for ${email}`);

        // Send invitation email
        await this.emailService.sendMail({
          to: email,
          subject: 'Invitation to Join Hexa AI',
          text: `You have been invited to join our company. Please click the link to accept the invitation: ${link}`,
          html: await this.getInvitationEmailTemplate(
            link,
            email,
            invitingUser,
            companyRole,
            companyId,
            expiresInHours,
          ),
        });
      }
      // User doesn't exist - send an email
      // await this.emailService.sendMail({
      //   to: email,
      //   subject: "Join Our Company",
      //   text: `You have been invited to join our company. Please visit the link to accept the invitation.`,
      //   html: `<p>You have been invited to join our company. Please visit the link to accept the invitation.</p>`,
      // });
      return {
        invitationSent: true,
        message: "Invitation sent to user's email.",
      };
    }
  }

  /**
   * Add existing user to company by ID
   */
  async addUser(companyId: string, userId: string, companyRole: string): Promise<User> {
    const company = await this.findOne(companyId);

    // Check if user already belongs to a company
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (user.companyId && user.companyId !== companyId) {
      throw new BadRequestException('User already belongs to another company. Remove them first.');
    }

    // Check user limit
    const maxUsers = company.settings.maxUsers ?? 5;
    if (maxUsers !== -1 && company.totalUsers >= maxUsers) {
      throw new BadRequestException(
        `Company has reached maximum user limit (${String(maxUsers)}). Upgrade plan to add more users.`,
      );
    }

    // Update user
    user.companyId = companyId;
    user.companyRole = companyRole;
    user.companyStatus = CompanyUserStatus.ACTIVE;

    await this.userRepository.save(user);

    // Increment company user count
    await this.companyRepository.increment({ id: companyId }, 'totalUsers', 1);

    this.logger.log(`Added user ${user.email} to company ${company.name} as ${companyRole}`);

    return user;
  }

  /**
   * Get default Hexa AI logo URL for emails
   */
  private getDefaultHexaLogo(): string {
    return 'https://gethexa.ai/_next/static/media/HexaRGBLogo.99148f1d.svg';
  }

  /**
   * Generate invitation email HTML template
   */
  private async getInvitationEmailTemplate(
    link: string,
    email: string,
    _invitingUser: User,
    companyRole: string,
    companyId: string,
    _expiresInHours: number,
  ): Promise<string> {
    const templatePath = path.join(process.cwd(), 'email_templates', 'invitation_email.html');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Default company info (Hexa AI)
    let companyName = 'Hexa AI';
    let companyLogo = this.getDefaultHexaLogo();
    let companyPrimaryColor = '#d5b1ff'; // Default purple

    // Try to get company info
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    if (company) {
      companyName = company.name || 'Hexa AI';
      // Only use company logo if it's not null, undefined, or empty string
      if (company.logo && company.logo.trim() !== '') {
        companyLogo = company.logo;
      }
      // Use company primary color or fall back to default purple
      if (company.primaryColor && company.primaryColor.trim() !== '') {
        companyPrimaryColor = company.primaryColor;
      }
    }

    // Replace template variables
    template = template
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{company_logo}}/g, companyLogo)
      .replace(/{{company_primary_color}}/g, companyPrimaryColor)
      .replace(/{{user_name}}/g, email.split('@')[0])
      .replace(/{{role}}/g, companyRole || 'Member')
      .replace(/{{registration_url}}/g, link)
      .replace(/{{support_url}}/g, 'mailto:support@hexa-ai.com')
      .replace(/{{live_chat_url}}/g, `${this.authConfig.frontendBaseUrl ?? this.appBaseUrl}/chat`)
      .replace(
        /{{help_documentation_url}}/g,
        `${this.authConfig.frontendBaseUrl ?? this.appBaseUrl}/docs`,
      );

    return template;
  }

  /**
   * Remove user from company
   */
  async removeUser(
    companyId: string,
    userId: string,
    opts?: { allowInactive?: boolean },
  ): Promise<void> {
    const company = await this.findOne(companyId, { allowInactive: opts?.allowInactive ?? false });
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (user.companyId !== companyId) {
      throw new BadRequestException('User does not belong to this company');
    }

    // Prevent removing the last owner
    if (user.companyRole === 'owner') {
      const ownerCount = await this.userRepository.count({
        where: { companyId, companyRole: 'owner' },
      });

      if (ownerCount <= 1) {
        throw new BadRequestException('Cannot remove the last owner. Assign another owner first.');
      }
    }

    // Remove user from company
    user.companyId = null;
    user.companyRole = 'user';

    await this.userRepository.save(user);

    // Decrement company user count
    await this.companyRepository.decrement({ id: companyId }, 'totalUsers', 1);

    this.logger.log(`Removed user ${user.email} from company ${company.name}`);
  }

  /**
   * Update a company member: role, profile fields, and/or company membership status.
   */
  async updateCompanyUser(
    companyId: string,
    userId: string,
    dto: {
      companyRole?: string;
      firstName?: string;
      lastName?: string;
      companyStatus?: CompanyUserStatus;
    },
    opts?: { allowInactive?: boolean },
  ): Promise<SanitizedUser> {
    const company = await this.findOne(companyId, { allowInactive: opts?.allowInactive ?? false });
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (user.companyId !== companyId) {
      throw new BadRequestException('User does not belong to this company');
    }

    const newRole = dto.companyRole;
    if (newRole !== undefined) {
      if (user.companyRole === 'owner' && newRole !== 'owner') {
        const ownerCount = await this.userRepository.count({
          where: { companyId, companyRole: 'owner' },
        });

        if (ownerCount <= 1) {
          throw new BadRequestException(
            'Cannot change role of the last owner. Assign another owner first.',
          );
        }
      }

      user.companyRole = newRole;
    }

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }
    if (dto.companyStatus !== undefined) {
      user.companyStatus = dto.companyStatus;
    }

    await this.userRepository.save(user);
    this.logger.log(`Updated company user ${user.email} in ${company.name}`);

    return this.usersService.sanitize(user);
  }

  /**
   * Remove (revoke) a pending invitation. Only company owner/admin or platform admin.
   */
  async removeInvitation(
    companyId: string,
    invitationId: string,
    opts?: { allowInactive?: boolean },
  ): Promise<{ deleted: true }> {
    await this.findOne(companyId, { allowInactive: opts?.allowInactive ?? false });
    const invitation = await this.invitationRepository.findOne({ where: { id: invitationId } });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.companyId !== companyId) {
      throw new NotFoundException('Invitation not found for this company');
    }
    if (invitation.usedAt) {
      throw new BadRequestException('Cannot remove an invitation that has already been accepted');
    }
    await this.invitationRepository.remove(invitation);
    return { deleted: true };
  }

  /**
   * Resend an invitation: new token/expiry and send invitation email again.
   */
  async resendInvitation(
    companyId: string,
    invitationId: string,
    opts?: { allowInactive?: boolean },
  ): Promise<{ resent: true }> {
    await this.findOne(companyId, { allowInactive: opts?.allowInactive ?? false });
    const invitation = await this.invitationRepository.findOne({ where: { id: invitationId } });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.companyId !== companyId) {
      throw new NotFoundException('Invitation not found for this company');
    }
    if (invitation.usedAt) {
      throw new BadRequestException('Cannot resend an invitation that has already been accepted');
    }

    const expiresInHours = this.authConfig.inviteExpiresHours;
    const expiresAt = this.addHoursToDate(new Date(), expiresInHours);
    const token = this.generateToken();

    invitation.token = token;
    invitation.expiresAt = expiresAt;
    await this.invitationRepository.save(invitation);

    const link = `${this.authConfig.frontendBaseUrl ?? this.appBaseUrl}/accept-invite?token=${token}&companyId=${companyId}`;

    let invitingUser: User | null = null;
    if (invitation.invitedById) {
      invitingUser = await this.userRepository.findOne({ where: { id: invitation.invitedById } });
    }
    const invitingUserForTemplate = invitingUser ?? ({} as User);

    await this.emailService.sendMail({
      to: invitation.email,
      subject: 'Invitation to Join Hexa AI',
      text: `You have been invited to join our company. Please click the link to accept the invitation: ${link}`,
      html: await this.getInvitationEmailTemplate(
        link,
        invitation.email,
        invitingUserForTemplate,
        invitation.companyRole,
        companyId,
        expiresInHours,
      ),
    });

    this.logger.log(`Resent invitation for ${invitation.email} in company ${companyId}`);
    return { resent: true };
  }

  /**
   * Get all users in a company (including pending invitations)
   */
  async getCompanyUsers(
    companyId: string,
    options: { allowInactive?: boolean } = {},
  ): Promise<{
    users: (SanitizedUser & { permissions: ReturnType<typeof resolveCompanyMemberPermissions> })[];
    pendingInvitations: {
      id: string;
      email: string;
      companyRole: string;
      permissions: ReturnType<typeof resolveCompanyMemberPermissions>;
      invitedBy?: string;
      expiresAt: Date;
      createdAt: Date;
    }[];
  }> {
    const allowInactive = options.allowInactive ?? false;
    await this.findOne(companyId, {
      allowInactive,
      inactiveAsForbidden: !allowInactive,
    });

    const users = await this.userRepository.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
      select: [
        'id',
        'email',
        'firstName',
        'lastName',
        'role',
        'companyRole',
        'companyStatus',
        'createdAt',
        'updatedAt',
      ],
    });

    // Get pending invitations for this company
    const pendingInvitations = await this.invitationRepository.find({
      where: {
        companyId,
      },
      relations: ['invitedBy'],
      order: { createdAt: 'DESC' },
    });

    // Filter out expired and used invitations
    const activePendingInvitations = pendingInvitations
      .filter(inv => !inv.usedAt && inv.expiresAt.getTime() > Date.now())
      .map(inv => ({
        id: inv.id,
        email: inv.email,
        companyRole: inv.companyRole,
        permissions: resolveCompanyMemberPermissions(inv.companyRole),
        invitedBy: inv.invitedBy?.email,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
      }));

    return {
      users: users.map(u => ({
        ...this.usersService.sanitize(u),
        permissions: resolveCompanyMemberPermissions(u.companyRole),
      })),
      pendingInvitations: activePendingInvitations,
    };
  }

  /**
   * Permanently delete a company and tenant-owned rows. Platform admin only.
   * Requires the exact company name as confirmation.
   */
  async deleteCompanyAsPlatformAdmin(
    companyId: string,
    confirmCompanyName: string,
  ): Promise<{ deleted: true; companyId: string }> {
    const company = await this.findOne(companyId, { allowInactive: true });
    if (company.name.trim() !== confirmCompanyName.trim()) {
      throw new BadRequestException(
        'confirmCompanyName must match the company name exactly (after trimming whitespace)',
      );
    }

    await this.dataSource.transaction(async manager => {
      await manager.delete(Invitation, { companyId });
      await manager.delete(ConversationFlow, { companyId });
      await manager.update(User, { companyId }, { companyId: null, companyRole: 'user' });
      await manager.update(Agent, { companyId }, { companyId: null });
      await manager.query(
        `UPDATE platform_inbound_voice_config SET "platformCompanyId" = NULL WHERE "platformCompanyId" = $1`,
        [companyId],
      );
      const result = await manager.delete(Company, { id: companyId });
      if (result.affected === 0) {
        throw new NotFoundException(`Company with ID "${companyId}" not found`);
      }
    });

    this.logger.warn(`Company deleted by platform admin: ${companyId} (${company.name})`);
    return { deleted: true, companyId };
  }

  /**
   * Soft-delete (deactivate) a company. Platform admin only.
   * Sets `isActive: false` so API key validation and inbound phone routing skip this tenant.
   * Idempotent if already inactive.
   */
  async softDeleteCompanyAsPlatformAdmin(companyId: string): Promise<Company> {
    const company = await this.findOne(companyId, { allowInactive: true });
    if (!company.isActive) {
      return company;
    }
    company.isActive = false;
    const saved = await this.companyRepository.save(company);
    this.logger.warn(`Company soft-deleted (deactivated): ${companyId} (${saved.name})`);
    return saved;
  }

  /**
   * Reactivate a soft-deleted (deactivated) company. Platform admin only.
   * Idempotent if already active.
   */
  async reactivateCompanyAsPlatformAdmin(companyId: string): Promise<Company> {
    const company = await this.findOne(companyId, { allowInactive: true });
    if (company.isActive) {
      return company;
    }
    company.isActive = true;
    const saved = await this.companyRepository.save(company);
    this.logger.log(`Company reactivated: ${companyId} (${saved.name})`);
    return saved;
  }

  private resolveInvitationCompanyRole(companyRole: string): CompanyRoles {
    const key = companyRole.toUpperCase();
    if (key === 'OWNER') return CompanyRoles.OWNER;
    if (key === 'ADMIN') return CompanyRoles.ADMIN;
    if (key === 'MEMBER') return CompanyRoles.MEMBER;
    return CompanyRoles.MEMBER;
  }

  private getPlanLimits(plan: string): Partial<NonNullable<Company['settings']>> {
    const limits: Record<
      'free' | 'starter' | 'professional' | 'enterprise',
      Partial<NonNullable<Company['settings']>>
    > = {
      free: {
        maxUsers: 5,
        maxCallsPerMonth: 100,
        features: {
          inboundCalls: true,
          outboundCalls: true,
          voiceAgent: true,
          callRecording: false,
          callAnalytics: true,
          apiAccess: false,
        },
      },
      starter: {
        maxUsers: 10,
        maxCallsPerMonth: 500,
        features: {
          inboundCalls: true,
          outboundCalls: true,
          voiceAgent: true,
          callRecording: true,
          callAnalytics: true,
          apiAccess: true,
        },
      },
      professional: {
        maxUsers: 50,
        maxCallsPerMonth: 5000,
        features: {
          inboundCalls: true,
          outboundCalls: true,
          voiceAgent: true,
          callRecording: true,
          callAnalytics: true,
          apiAccess: true,
        },
      },
      enterprise: {
        maxUsers: -1, // Unlimited
        maxCallsPerMonth: -1, // Unlimited
        features: {
          inboundCalls: true,
          outboundCalls: true,
          voiceAgent: true,
          callRecording: true,
          callAnalytics: true,
          apiAccess: true,
        },
      },
    };

    const tier = plan as keyof typeof limits;
    return tier in limits ? limits[tier] : limits.free;
  }

  private generateToken(length = 32): string {
    return randomBytes(length).toString('hex');
  }

  private addHoursToDate(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 60 * 60 * 1000);
  }
}
