import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as readline from 'readline';

import { CallStateService } from '../calls/services/call-state.service';
import { CallStatus } from '../calls/types/call-state.types';
import { OpenAIModel } from '../common/enums';
import {
  createTerminalDummyWebSocket,
  ElevenLabsVoiceBridgeService,
} from './elevanlabs.voice-bridge-service.service';

/**
 * - Idle terminal chat when `voice.terminalRepl` (VOICE_MODE=local + VOICE_TERMINAL_REPL=true).
 * - Outbound API simulation: `CallsService` calls `attachOutboundTerminalSession` when Twilio is skipped.
 */
@Injectable()
export class VoiceTerminalReplService implements OnModuleInit {
  private readonly logger = new Logger(VoiceTerminalReplService.name);
  /** One interactive stdin session at a time */
  private stdinSessionReserved = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly callStateService: CallStateService,
    private readonly bridge: ElevenLabsVoiceBridgeService,
  ) {}

  onModuleInit(): void {
    const enabled = this.configService.get<boolean>('voice.terminalRepl');
    if (!enabled) return;

    if (!process.stdin.isTTY) {
      this.logger.warn(
        'voice.terminalRepl is enabled but stdin is not a TTY; skipping idle terminal chat.',
      );
      return;
    }

    setImmediate(() => {
      void this.runIdleBootstrap().catch((err: unknown) => {
        this.logger.error('Idle terminal REPL failed:', err);
      });
    });
  }

  /**
   * After `POST /calls` in local voice mode: attach stdin readline + bridge to an existing callSid.
   * Returns false if stdin is not a TTY or already in use.
   */
  attachOutboundTerminalSession(callSid: string): boolean {
    if (!process.stdin.isTTY) {
      this.logger.warn(
        `Local simulated call ${callSid}: stdin is not a TTY — run the API server in an interactive terminal to chat.`,
      );
      return false;
    }
    if (!this.reserveStdinSession()) {
      this.logger.warn(
        `Local simulated call ${callSid}: stdin already in use (idle REPL or another session).`,
      );
      return false;
    }

    void this.startInteractiveLoopForCall(
      callSid,
      `\n━━ Outbound call simulation (${callSid}) — no Twilio. Commands: /quit, /exit\n\n`,
    ).catch((err: unknown) => {
      this.logger.error(`Terminal loop failed for ${callSid}:`, err);
      this.releaseStdinSession();
    });

    return true;
  }

  private reserveStdinSession(): boolean {
    if (!process.stdin.isTTY) return false;
    if (this.stdinSessionReserved) return false;
    this.stdinSessionReserved = true;
    return true;
  }

  private releaseStdinSession(): void {
    this.stdinSessionReserved = false;
  }

  private async runIdleBootstrap(): Promise<void> {
    if (!this.reserveStdinSession()) {
      this.logger.warn('Idle terminal REPL skipped: stdin unavailable or already reserved.');
      return;
    }

    const callSid = `CA_TERMINAL_${crypto.randomBytes(8).toString('hex')}`;
    const scriptFromEnv = process.env.VOICE_TERMINAL_SCRIPT?.trim();
    const script =
      scriptFromEnv && scriptFromEnv.length > 0
        ? scriptFromEnv
        : 'You are a helpful assistant. Keep replies concise for chat.';

    let metadata: Record<string, unknown> = { terminalRepl: true };
    const metaJson = process.env.VOICE_TERMINAL_METADATA?.trim();
    if (metaJson) {
      try {
        const parsed = JSON.parse(metaJson) as Record<string, unknown>;
        metadata = { ...metadata, ...parsed };
      } catch (e: unknown) {
        this.logger.error('VOICE_TERMINAL_METADATA must be valid JSON; using defaults only.', e);
      }
    }

    const flowId = process.env.VOICE_TERMINAL_FLOW_ID?.trim();
    if (flowId) {
      metadata.flowId = flowId;
      const fc = process.env.VOICE_TERMINAL_FLOW_COMPANY_ID?.trim();
      const co = process.env.VOICE_TERMINAL_COMPANY_ID?.trim();
      const flowCompany = fc !== undefined && fc !== '' ? fc : co;
      if (flowCompany !== undefined && flowCompany !== '') {
        metadata.flowCompanyId = flowCompany;
      }
    }

    const companyId = process.env.VOICE_TERMINAL_COMPANY_ID?.trim();
    const model = process.env.VOICE_TERMINAL_MODEL ?? OpenAIModel.GPT_4O_MINI;

    this.logger.log(
      `Idle terminal voice chat — callSid=${callSid} (logs also show User said / Agent lines)`,
    );

    const voiceIdEnv = process.env.VOICE_TERMINAL_VOICE_ID?.trim();
    const voiceId = voiceIdEnv && voiceIdEnv.length > 0 ? voiceIdEnv : 'default';

    try {
      this.callStateService.create({
        callSid,
        phoneNumberFrom: 'terminal',
        phoneNumberTo: 'local',
        script,
        model,
        voiceId,
        provider: 'terminal-repl',
        status: CallStatus.INITIATING,
        metadata,
        companyId: companyId !== undefined && companyId !== '' ? companyId : undefined,
      });

      this.callStateService.updateStatus(callSid, CallStatus.ACTIVE);

      await this.startInteractiveLoopForCall(
        callSid,
        '\n━━ Terminal voice chat — no Twilio/TTS. Commands: /quit, /exit\n\n',
      );
    } catch (e: unknown) {
      this.releaseStdinSession();
      throw e;
    }
  }

  private async startInteractiveLoopForCall(callSid: string, banner?: string): Promise<void> {
    if (banner) {
      process.stdout.write(banner);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    try {
      await this.bridge.start(callSid, callSid, createTerminalDummyWebSocket(), {
        terminalTextOnly: true,
        onTerminalSessionEnd: () => {
          this.releaseStdinSession();
          rl.close();
        },
      });

      const promptLoop = (): void => {
        rl.question('You: ', line => {
          void this.handleReplLine(callSid, line.trim(), rl, promptLoop);
        });
      };

      promptLoop();
    } catch (e: unknown) {
      this.releaseStdinSession();
      rl.close();
      throw e;
    }
  }

  private async handleReplLine(
    callSid: string,
    trimmed: string,
    rl: readline.Interface,
    promptLoop: () => void,
  ): Promise<void> {
    if (trimmed === '/quit' || trimmed === '/exit') {
      this.logger.log('Terminal REPL: quit command');
      this.bridge.stop(callSid, 'terminal_repl_quit_command');
      try {
        if (this.callStateService.findOne(callSid)) {
          this.callStateService.updateStatus(callSid, CallStatus.COMPLETED);
        }
      } catch (e: unknown) {
        this.logger.debug(`Status update on quit: ${String(e)}`);
      }
      rl.close();
      return;
    }
    if (trimmed === '') {
      promptLoop();
      return;
    }

    this.logger.log(`📝 User said [${callSid}]: "${trimmed}"`);

    try {
      await this.bridge.processUserTranscript(callSid, trimmed);
    } catch (e: unknown) {
      this.logger.error('processUserTranscript failed:', e);
    }
    promptLoop();
  }
}
