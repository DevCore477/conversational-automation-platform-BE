// guards/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';

import { UnifiedAuthGuard } from './unified-auth.guard';
import { TokenValidationService } from '../auth/services/token-validation.service';

@Injectable()
export class JwtAuthGuard extends UnifiedAuthGuard {
  constructor(tokenValidationService: TokenValidationService) {
    super(tokenValidationService);
    // Override defaults
    this.allowJwt = true;
    this.allowApiKey = false;
    this.optional = false;
  }
}
