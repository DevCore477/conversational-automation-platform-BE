import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService, ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StringValue } from 'ms';
import { EntityManager, Repository } from 'typeorm';

import { UserRole } from '../common/enums';
import { CompaniesService } from '../companies/companies.service';
import authConfig from '../configs/auth.config';
import mozoConfig from '../configs/mozo.config';
import { EmailService } from '../email/email.service';
import { Company } from '../models/companies/company.entity';
import { Invitation } from '../models/users/invitation.entity';
import { PasswordResetToken } from '../models/users/password-reset-token.entity';
import { RefreshToken } from '../models/users/refresh-token.entity';
import { User } from '../models/users/user.entity';
import { UsersService } from '../users/users.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenBodyDto } from './dto/refresh-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import {
  type CompanyWhatsAppStatus,
  WhatsAppConfigService,
} from '../whatsapp/services/whatsapp-config.service';

/** Fixed, non-routable-looking local part so these rows are unmistakable in the DB and never collide with a real signup. */
const EMBEDDED_SESSION_EMAIL_DOMAIN = 'embedded-session.internal.conversational-ai.local';
/** company_role for synthetic embedded-session users — deliberately not 'owner'/'admin' so every existing owner/admin-only check rejects it. */
const EMBEDDED_SESSION_COMPANY_ROLE = 'embedded';

export interface AuthResponse {
  accessToken: string;
  /** Opaque token; returned from login, signup, accept-invite, refresh — not from `/auth/me`. */
  refreshToken?: string;
  user: ReturnType<UsersService['sanitize']>;
  /** WhatsApp tenant config flags (null when user has no company). */
  whatsapp: CompanyWhatsAppStatus | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly passwordSaltRounds: number;
  private readonly inviteExpiresHours: number;
  private readonly resetTokenExpiresHours: number;
  private readonly refreshTokenExpiresDays: number;
  private readonly frontendBaseUrl: string;
  private readonly embeddedSessionAccessExpiresIn: StringValue;
  private readonly mozoSingleTenantCompanyId: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly companyService: CompaniesService,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(PasswordResetToken)
    private readonly resetTokenRepository: Repository<PasswordResetToken>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    private readonly whatsappConfigService: WhatsAppConfigService,
  ) {
    const authCfg = this.configService.getOrThrow<ConfigType<typeof authConfig>>('auth');

    this.passwordSaltRounds = authCfg.passwordSaltRounds;
    this.inviteExpiresHours = authCfg.inviteExpiresHours;
    this.resetTokenExpiresHours = authCfg.resetTokenExpiresHours;
    this.refreshTokenExpiresDays = authCfg.refreshTokenExpiresDays;
    this.frontendBaseUrl = authCfg.frontendBaseUrl ?? 'http://localhost:3000';
    this.embeddedSessionAccessExpiresIn = authCfg.embeddedSessionAccessExpiresIn as StringValue;
    this.mozoSingleTenantCompanyId =
      this.configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo').singleTenantCompanyId;
  }

  // ==================== Public Methods ====================

  async getAuthState() {
    const userCount = await this.usersService.countUsers();
    return { hasUsers: userCount > 0 };
  }

  async signupFirstUser(dto: SignupDto): Promise<AuthResponse> {
    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.usersService.createUser({
      email: dto.email.toLowerCase(),
      firstName: dto.firstName,
      lastName: dto.lastName,
      passwordHash,
      role: UserRole.ADMIN,
    });

    return this.issueSession(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateCredentials(dto.email, dto.password);
    await this.assertTenantCompanyActive(user);
    return this.issueSession(user);
  }

  /**
   * Mints a real, short-lived login session for the single Mozo tenant — same response
   * shape as `login`, minus `refreshToken`. Used to bridge iframe-embedded integrations
   * (e.g. Mozo) whose SameSite=strict cookies never reach us, so the app would otherwise
   * look logged-out despite the caller already being trusted via the bridge shared secret
   * (validated by the caller's guard, not by this method).
   *
   * Single-tenant by design: there is exactly one company this ever mints a session for,
   * configured via MOZO_SINGLE_TENANT_COMPANY_ID — not derived from the request at all.
   *
   * No refresh token is issued: the session is meant to be short-lived and re-minted
   * from the bridge secret on demand, not persisted like a normal browser login.
   */
  async embeddedSession(): Promise<AuthResponse> {
    if (!this.mozoSingleTenantCompanyId) {
      throw new Error('MOZO_SINGLE_TENANT_COMPANY_ID is not configured');
    }

    await this.assertCompanyActiveById(this.mozoSingleTenantCompanyId);

    const user = await this.getOrCreateEmbeddedSessionUser(this.mozoSingleTenantCompanyId);

    this.logger.log(
      `Embedded session minted for company ${this.mozoSingleTenantCompanyId} at ${new Date().toISOString()}`,
    );

    return {
      accessToken: this.buildAccessToken(user, this.embeddedSessionAccessExpiresIn),
      user: this.usersService.sanitize(user),
      whatsapp: await this.resolveWhatsAppStatus(user.companyId),
    };
  }

  async inviteUser(dto: InviteUserDto, invitedById: string) {
    await this.ensureUserCanInvite(invitedById);
    await this.ensureEmailAvailable(dto.email);

    const invitation = await this.createInvitation(dto, invitedById);
    await this.sendInvitationEmail(invitation, dto.email);

    return {
      success: true,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    };
  }

  async acceptInvite(dto: AcceptInviteDto): Promise<AuthResponse> {
    const invitation = await this.validateInvitation(dto.token);

    if (invitation.companyId) {
      await this.companyService.findOne(invitation.companyId);
    }

    const user = await this.createUserFromInvitation(dto, invitation);
    await this.markInvitationUsed(invitation);
    const companyId = await this.addUserToCompany(invitation);
    if (companyId) {
      return this.issueSession({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        companyId,
        companyRole: invitation.companyRole,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    } else {
      return this.issueSession(user);
    }
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email.toLowerCase());

    if (user) {
      const resetToken = await this.createPasswordResetToken(user.id);
      await this.sendPasswordResetEmail(user, resetToken);
    }

    // Always return success to prevent email enumeration
    return { success: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const resetToken = await this.validateResetToken(dto.token);

    await this.updateUserPassword(resetToken.userId, dto.password);
    await this.markResetTokenUsed(resetToken);
    await this.refreshTokenRepository.delete({ userId: resetToken.userId });

    return { success: true };
  }

  async getCurrentUser(userId: string): Promise<AuthResponse> {
    const user = await this.usersService.findById(userId);
    await this.assertTenantCompanyActive(user);
    // Embedded sessions must never renew into a normal long-lived token via /auth/me —
    // that would silently defeat their whole short-expiry, no-refresh-token design.
    const isEmbeddedSession = user.companyRole === EMBEDDED_SESSION_COMPANY_ROLE;
    return {
      accessToken: this.buildAccessToken(
        user,
        isEmbeddedSession ? this.embeddedSessionAccessExpiresIn : undefined,
      ),
      user: this.usersService.sanitize(user),
      whatsapp: await this.resolveWhatsAppStatus(user.companyId),
    };
  }

  async refresh(dto: RefreshTokenBodyDto): Promise<AuthResponse> {
    const tokenHash = this.hashToken(dto.refreshToken);
    return this.refreshTokenRepository.manager.transaction(async manager => {
      const repo = manager.getRepository(RefreshToken);
      const row = await repo.findOne({ where: { tokenHash } });
      if (!row || row.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }
      const user = await this.usersService.findById(row.userId);
      await this.assertTenantCompanyActive(user);
      await repo.delete({ id: row.id });
      const refreshToken = await this.createRefreshTokenForUser(user.id, manager);
      return {
        accessToken: this.buildAccessToken(user),
        refreshToken,
        user: this.usersService.sanitize(user),
        whatsapp: await this.resolveWhatsAppStatus(user.companyId),
      };
    });
  }

  /** Revokes a single refresh token (idempotent). */
  async logout(dto: RefreshTokenBodyDto): Promise<{ success: true }> {
    const tokenHash = this.hashToken(dto.refreshToken);
    await this.refreshTokenRepository.delete({ tokenHash });
    return { success: true };
  }

  // ==================== Private Helper Methods ====================

  /** Block JWT/session flows for users whose company was soft-deleted (platform admins exempt). */
  private async assertTenantCompanyActive(user: User): Promise<void> {
    if (user.role === UserRole.ADMIN) {
      return;
    }
    if (!user.companyId) {
      return;
    }
    const company = await this.companyRepository.findOne({ where: { id: user.companyId } });
    if (company && !company.isActive) {
      throw new UnauthorizedException('This company has been deactivated');
    }
  }

  /** Same intent as {@link assertTenantCompanyActive} but for callers that only have a companyId (e.g. the embedded-session flow). */
  private async assertCompanyActiveById(companyId: string): Promise<void> {
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!company) {
      throw new UnauthorizedException('Company not found');
    }
    if (!company.isActive) {
      throw new UnauthorizedException('This company has been deactivated');
    }
  }

  private embeddedSessionEmail(companyId: string): string {
    return `embedded-session+${companyId}@${EMBEDDED_SESSION_EMAIL_DOMAIN}`;
  }

  /**
   * Gets (or lazily creates) the one synthetic, password-less user that represents
   * "this company, via an embedded integration". Not a real human — role/companyRole
   * are pinned to the least-privileged tenant tier so embedded sessions never reach
   * owner/admin-gated actions (company settings, billing, user management, API keys).
   */
  private async getOrCreateEmbeddedSessionUser(companyId: string): Promise<User> {
    const email = this.embeddedSessionEmail(companyId);
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      return existing;
    }

    try {
      const passwordHash = await this.hashPassword(this.generateToken(32));
      return await this.usersService.createUser({
        email,
        firstName: 'Embedded',
        lastName: 'Session',
        passwordHash,
        role: UserRole.MEMBER,
        companyId,
        companyRole: EMBEDDED_SESSION_COMPANY_ROLE,
      });
    } catch (error) {
      // Concurrent first-ever call for this company can race on the unique email;
      // fall back to whichever row won instead of failing the request.
      const fallback = await this.usersService.findByEmail(email);
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  }

  private async validateCredentials(email: string, password: string): Promise<User> {
    const user = await this.usersService.findByEmail(email.toLowerCase());

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return user;
  }

  private async ensureUserCanInvite(invitedById: string): Promise<void> {
    const user = await this.usersService.findById(invitedById);
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can invite new users');
    }
  }

  private async ensureEmailAvailable(email: string): Promise<void> {
    const existing = await this.usersService.findByEmail(email.toLowerCase());
    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }
  }

  private async createInvitation(dto: InviteUserDto, invitedById: string): Promise<Invitation> {
    const expiresInHours = dto.expiresInHours ?? this.inviteExpiresHours;

    const invitation = this.invitationRepository.create({
      email: dto.email.toLowerCase(),
      token: this.generateToken(),
      role: dto.role ?? UserRole.MEMBER,
      invitedById,
      expiresAt: this.addHours(new Date(), expiresInHours),
    });

    return this.invitationRepository.save(invitation);
  }

  private async sendInvitationEmail(invitation: Invitation, email: string): Promise<void> {
    const link = `${this.frontendBaseUrl}/accept-invite?token=${invitation.token}`;
    let invitingUser: User | undefined;
    if (invitation.invitedById) {
      invitingUser = await this.usersService.findById(invitation.invitedById);
    }

    await this.emailService.sendMail({
      to: email,
      subject: 'Invitation to Join Hexa AI',
      html: await this.getInvitationEmailTemplate(link, invitation, invitingUser),
    });
  }

  private getDefaultHexaLogo(): string {
    // Use GitHub raw URL for the PNG logo (publicly accessible)
    // PNG format works better in email clients than SVG
    return 'https://gethexa.ai/_next/static/media/HexaRGBLogo.99148f1d.svg';
  }

  private async getInvitationEmailTemplate(
    link: string,
    invitation: Invitation,
    invitingUser?: User,
  ): Promise<string> {
    const templatePath = path.join(process.cwd(), 'email_templates', 'invitation_email.html');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Default company info (Hexa AI)
    let companyName = 'Hexa AI';
    let companyLogo = this.getDefaultHexaLogo();
    let companyPrimaryColor = '#d5b1ff'; // Default purple

    // Try to get company info from inviting user
    if (invitingUser?.companyId) {
      const company = await this.companyRepository.findOne({
        where: { id: invitingUser.companyId },
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
    }

    // Replace template variables
    template = template
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{company_logo}}/g, companyLogo)
      .replace(/{{company_primary_color}}/g, companyPrimaryColor)
      .replace(/{{user_name}}/g, invitation.email.split('@')[0])
      .replace(/{{role}}/g, invitation.companyRole)
      .replace(/{{registration_url}}/g, link)
      .replace(/{{support_url}}/g, 'mailto:support@hexa-ai.com')
      .replace(/{{live_chat_url}}/g, `${this.frontendBaseUrl}/chat`)
      .replace(/{{help_documentation_url}}/g, `${this.frontendBaseUrl}/docs`);

    return template;
  }

  private async validateInvitation(token: string): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
    });

    if (!invitation) {
      throw new BadRequestException('Invitation is invalid');
    }

    if (invitation.usedAt) {
      throw new BadRequestException('Invitation has already been used');
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invitation link has expired');
    }

    return invitation;
  }

  private async createUserFromInvitation(
    dto: AcceptInviteDto,
    invitation: Invitation,
  ): Promise<User> {
    const passwordHash = await this.hashPassword(dto.password);

    return this.usersService.createUser({
      email: invitation.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      passwordHash,
      role: invitation.role,
      invitedById: invitation.invitedById,
    });
  }

  private async markInvitationUsed(invitation: Invitation): Promise<void> {
    invitation.usedAt = new Date();
    await this.invitationRepository.save(invitation);
  }

  private async addUserToCompany(invitation: Invitation): Promise<string | undefined> {
    if (invitation.companyId != null) {
      const response = await this.companyService.addUserByEmail(
        invitation.companyId,
        invitation.email,
        invitation.companyRole,
        false,
        invitation.invitedById,
      );
      return response.user?.companyId ?? undefined;
    }
    return undefined;
  }

  private async createPasswordResetToken(userId: string): Promise<string> {
    await this.resetTokenRepository.delete({ userId });

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);

    const resetToken = this.resetTokenRepository.create({
      tokenHash,
      userId,
      expiresAt: this.addHours(new Date(), this.resetTokenExpiresHours),
    });

    await this.resetTokenRepository.save(resetToken);
    return token;
  }

  private async sendPasswordResetEmail(user: User, token: string): Promise<void> {
    const link = `${this.frontendBaseUrl}/reset-password?token=${token}`;

    await this.emailService.sendMail({
      to: user.email,
      subject: 'Password Reset Request for Hexa AI',
      html: await this.getPasswordResetEmailTemplate(user, link),
    });
  }

  private async getPasswordResetEmailTemplate(user: User, link: string): Promise<string> {
    const templatePath = path.join(process.cwd(), 'email_templates', 'forgot_password_email.html');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Default company info (Hexa AI)
    let companyName = 'Hexa AI';
    let companyLogo = this.getDefaultHexaLogo();
    let companyPrimaryColor = '#d5b1ff'; // Default purple

    // Try to get company info from user
    if (user.companyId) {
      const company = await this.companyRepository.findOne({
        where: { id: user.companyId },
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
    }

    // Replace template variables
    template = template
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{company_logo}}/g, companyLogo)
      .replace(/{{company_primary_color}}/g, companyPrimaryColor)
      .replace(/{{user_name}}/g, user.firstName || user.email.split('@')[0])
      .replace(/{{reset_password_url}}/g, link)
      .replace(/{{support_url}}/g, 'mailto:support@hexa-ai.com')
      .replace(/{{live_chat_url}}/g, `${this.frontendBaseUrl}/chat`);

    return template;
  }

  private async validateResetToken(token: string): Promise<PasswordResetToken> {
    const tokenHash = this.hashToken(token);
    const resetToken = await this.resetTokenRepository.findOne({
      where: { tokenHash },
    });

    if (!resetToken || resetToken.usedAt || resetToken.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Reset link is invalid or expired');
    }

    return resetToken;
  }

  private async updateUserPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await this.hashPassword(password);
    await this.usersService.updatePassword(userId, passwordHash);
  }

  private async markResetTokenUsed(resetToken: PasswordResetToken): Promise<void> {
    resetToken.usedAt = new Date();
    await this.resetTokenRepository.save(resetToken);
  }

  // ==================== Utility Methods ====================

  private hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.passwordSaltRounds);
  }

  private buildAccessToken(user: User, expiresInOverride?: StringValue): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      companyRole: user.companyRole,
    };
    return expiresInOverride
      ? this.jwtService.sign(payload, { expiresIn: expiresInOverride })
      : this.jwtService.sign(payload);
  }

  private async resolveWhatsAppStatus(
    companyId: string | null | undefined,
  ): Promise<CompanyWhatsAppStatus | null> {
    if (!companyId) {
      return null;
    }
    return this.whatsappConfigService.getCompanyWhatsAppStatus(companyId);
  }

  private async issueSession(user: User): Promise<AuthResponse> {
    const refreshToken = await this.createRefreshTokenForUser(user.id);
    return {
      accessToken: this.buildAccessToken(user),
      refreshToken,
      user: this.usersService.sanitize(user),
      whatsapp: await this.resolveWhatsAppStatus(user.companyId),
    };
  }

  private async createRefreshTokenForUser(
    userId: string,
    manager?: EntityManager,
  ): Promise<string> {
    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = this.addDays(new Date(), this.refreshTokenExpiresDays);
    const repo = manager ? manager.getRepository(RefreshToken) : this.refreshTokenRepository;
    await repo.save(repo.create({ userId, tokenHash, expiresAt }));
    return token;
  }

  private generateToken(length = 32): string {
    return randomBytes(length).toString('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private addHours(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 60 * 60 * 1000);
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
