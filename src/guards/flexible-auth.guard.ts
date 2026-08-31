// guards/flexible-auth.guard.ts
import { Injectable } from '@nestjs/common';

import { UnifiedAuthGuard } from './unified-auth.guard';
import { TokenValidationService } from '../auth/services/token-validation.service';

@Injectable()
export class FlexibleAuthGuard extends UnifiedAuthGuard {
  constructor(tokenValidationService: TokenValidationService) {
    super(tokenValidationService);
    this.allowApiKey = true;
    this.allowJwt = true;
    this.optional = false;
  }
}
