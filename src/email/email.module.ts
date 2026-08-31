import { forwardRef, Module } from '@nestjs/common';

import { EmailService } from './email.service';
import { SendGridClient } from './sendgrid-client';
import { CompaniesModule } from '../companies/companies.module';

@Module({
  imports: [forwardRef(() => CompaniesModule)],
  providers: [EmailService, SendGridClient],
  exports: [EmailService],
})
export class EmailModule {}
