import { Body, Controller, Get, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { UserRole } from '../common/enums';
import { JwtAuthGuard, RolesGuard } from '../guards';
import { User } from '../models/users/user.entity';
import { MozoBridgeSecretGuard } from '../mozo/guards/mozo-bridge-secret.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Roles } from './decorators/roles.decorator';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenBodyDto } from './dto/refresh-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { EmbeddedSessionRateLimitGuard } from './guards/embedded-session-rate-limit.guard';

type RequestWithUser = Request & { user: User };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('state')
  @ApiOperation({ summary: 'Get basic authentication state' })
  async getState() {
    return this.authService.getAuthState();
  }

  @Post('signup')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create the very first admin account' })
  @ApiResponse({ status: 201, description: 'Admin created and logged in' })
  @ApiBadRequestResponse({ description: 'Validation error' })
  async signup(@Body() dto: SignupDto) {
    return this.authService.signupFirstUser(dto);
  }

  @Post('login')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('embedded-session')
  @UseGuards(EmbeddedSessionRateLimitGuard, MozoBridgeSecretGuard)
  @ApiOperation({
    summary:
      'Mint a short-lived, restricted login session for the single Mozo tenant, given the ' +
      'X-Mozo-Bridge-Secret header. Same response shape as /auth/login, minus refreshToken. ' +
      'Server-to-server only; never call this from a browser.',
  })
  async embeddedSession() {
    return this.authService.embeddedSession();
  }

  @Post('refresh')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Exchange a refresh token for new access and refresh tokens' })
  @ApiResponse({ status: 200, description: 'New session issued' })
  @ApiBadRequestResponse({ description: 'Validation error' })
  async refresh(@Body() dto: RefreshTokenBodyDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Revoke a refresh token (client should discard tokens after)' })
  async logout(@Body() dto: RefreshTokenBodyDto) {
    return this.authService.logout(dto);
  }

  @Post('invite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UsePipes(ZodValidationPipe)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Invite a team member (admin only)' })
  async invite(@Body() dto: InviteUserDto, @Req() req: RequestWithUser) {
    return this.authService.inviteUser(dto, req.user.id);
  }

  @Post('accept-invite')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Accept an invitation and create an account' })
  async acceptInvite(@Body() dto: AcceptInviteDto) {
    return this.authService.acceptInvite(dto);
  }

  @Post('forgot-password')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Request a password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Reset password using a one-time token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Get current authenticated user information' })
  @ApiResponse({ status: 200, description: 'Current user information' })
  async getCurrentUser(@Req() req: RequestWithUser) {
    return await this.authService.getCurrentUser(req.user.id);
  }
}
