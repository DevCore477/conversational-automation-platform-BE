// import { Injectable } from "@nestjs/common";
// import { ConfigService } from "@nestjs/config";
// import { MailDataRequired } from "@sendgrid/mail";
//
// import { EmailTypeEnum } from "../common/enums";
//
// import { SendGridClient } from "./sendgrid-client";
//
// type InvitationPayload = {
//   userName: string;
//   inviteLink: string;
// };
//
// type ResetPayload = {
//   resetLink: string;
//   userName: string;
//   expiryMinutes: number;
// };
//
// type TemplatePayloadMap = {
//   [EmailTypeEnum.INVITATION_EMAIL]: InvitationPayload;
//   [EmailTypeEnum.PASSWORD_RESET]: ResetPayload;
// };
//
// @Injectable()
// export class EmailService {
//   constructor(
//     private readonly sendGridClient: SendGridClient,
//     private readonly config: ConfigService,
//   ) {}
//
//   private from() {
//     return (
//       this.config.get<string>("EMAIL_FROM") ??
//       "muhammadali.raza@verdant-soft.com"
//     );
//   }
//   async sendTestEmail(
//     recipient: string,
//     body = "This is a test mail",
//   ): Promise<void> {
//     const mail: MailDataRequired = {
//       to: recipient,
//       from: process.env.EMAIL_FROM ?? "muhammadali.raza@verdant-soft.com", //Approved sender ID in Sendgrid
//       subject: "Test email",
//       content: [{ type: "text/plain", value: body }],
//     };
//     await this.sendGridClient.send(mail);
//   }
//
//   private templateId(type: EmailTypeEnum) {
//     const map: Record<EmailTypeEnum, string> = {
//       [EmailTypeEnum.INVITATION_EMAIL]:
//         this.config.get<string>("SENDGRID_TEMPLATE_INVITE") ??
//         "d-e3248d7adf38479bad0462102269ec2e",
//       [EmailTypeEnum.PASSWORD_RESET]:
//         this.config.get<string>("SENDGRID_TEMPLATE_RESET") ??
//         "d-a814e118ec8740a49117b74cb5ca3678",
//     };
//     return map[type];
//   }
//
//   async sendEmailWithTemplate<T extends EmailTypeEnum>(
//     recipient: string | string[],
//     templateType: T,
//     data: TemplatePayloadMap[T],
//   ): Promise<void> {
//     console.log("Sending email", { recipient, templateType, data });
//     const mail: MailDataRequired = {
//       to: recipient,
//       from: this.from(),
//       templateId: this.templateId(templateType),
//       dynamicTemplateData: data,
//       // optional but useful:
//       categories: ["calling-bot", templateType],
//     };
//     await this.sendGridClient.send(mail);
//   }
// }

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST'),
      port: Number(this.config.get<string>('SMTP_PORT')),
      secure: false, // false for 587, true for 465
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
    });

    // 🔍 Verify SMTP connection ONCE at startup
    this.transporter
      .verify()
      .then(() => {
        this.logger.debug(`✅ SMTP ready`);
      })
      .catch(err => {
        console.error('❌ SMTP connection failed', err);
      });
  }

  async sendMail({
    to,
    subject,
    text,
    html,
  }: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }) {
    try {
      const isMailWorking = await this.transporter.verify();
      if (!isMailWorking) {
        this.logger.warn('Email service not available');
        throw new ServiceUnavailableException(
          'Email service is temporarily unavailable. Please try again later.',
        );
      }
      return await this.transporter.sendMail({
        from: this.config.get<string>('EMAIL_FROM'),
        to,
        subject,
        text,
        html,
      });
    } catch (error: unknown) {
      const err = error as { responseCode?: number; response?: string; code?: string };
      const message = typeof err?.response === 'string' ? err.response : '';
      const code = err?.responseCode ?? err?.code;

      this.logger.error(`Send mail failed: ${message || (error as Error)?.message}`);

      // SES/sandbox: recipient or sender not verified (554)
      if (code === 554 || /not verified|rejected|failed the check/i.test(message)) {
        throw new BadRequestException(
          'Unable to send email: the email address is not verified. ' +
            'In development, only verified addresses can receive mail.',
        );
      }

      // Other SMTP/server errors
      if (code === 550 || code === 553 || /recipient|address|invalid/i.test(message)) {
        throw new BadRequestException(
          'Unable to send email: invalid or rejected recipient address.',
        );
      }

      // Re-throw if already a Nest HTTP exception (e.g. ServiceUnavailable from above)
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new ServiceUnavailableException('Failed to send email. Please try again later.');
    }
  }
}
