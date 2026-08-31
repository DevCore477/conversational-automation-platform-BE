import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TwilioWebhookDto } from './dto/twilio-webhook.dto';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * TwiML for ElevenLabs voice agent (BIDIRECTIONAL streaming)
   * This connects the Twilio call to the WebSocket endpoint
   * which bridges to ElevenLabs for conversational AI with TTS
   */
  generateVoiceAgentTwiml(): string {
    const wsUrl = this.getVoiceStreamWsUrl();

    this.logger.log(`📡 Generating TwiML for WebSocket: ${wsUrl}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    this.logger.log(`📄 TwiML generated:\n${twiml}`);

    return twiml;
  }

  /**
   * TwiML that declines the call outright (no ringing, no voicemail) — used when inbound
   * admission control is at capacity (MAX_CONCURRENT_INBOUND_CALLS / MAX_CONCURRENT_CALLS) and
   * the call must be turned away instead of being answered with no worker to handle it.
   */
  generateRejectTwiml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`;
  }

  /**
   * TwiML that bridges the current caller to a support / human line (used after Twilio REST redirect).
   */
  generateDialSupportTwiml(supportNumberE164: string, callerIdForDialLeg: string): string {
    const dest = supportNumberE164.trim();
    const cid = callerIdForDialLeg.trim();
    this.logger.log(`📞 Generating Dial TwiML → ${dest} (callerId=${cid})`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${this.escapeXmlAttr(cid)}" timeout="45" answerOnBridge="true">
    <Number>${this.escapeXmlAttr(dest)}</Number>
  </Dial>
</Response>`;
  }

  private escapeXmlAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  getVoiceStreamWsUrl(): string {
    let baseURL = this.configService.get<string>('webhook.baseUrl');
    if (!baseURL) {
      this.logger.error('⚠️ WEBHOOK_BASE_URL not configured! WebSocket connection will fail.');
      baseURL = 'localhost:3000';
    }
    baseURL = baseURL.replace(/^https?:\/\//, '');
    return `wss://${baseURL}/ws/voice-media`;
  }

  /** TeXML response for Telnyx SIP/voice webhooks. */
  generateVoiceAgentTeXml(): string {
    const wsUrl = this.getVoiceStreamWsUrl();
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" bidirectionalMode="rtp" />
  </Connect>
</Response>`;
  }

  /**
   * Generate simple TwiML response (fallback)
   */
  generateTwiml(message = 'Hello! This is a test call.'): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${this.escapeXml(message)}</Say>
</Response>`;
  }

  /**
   * Generate TwiML with Gather for speech recognition
   * This is the main method used for conversational calls
   */
  generateGatherTwiml(callSid: string, prompt?: string, actionUrl?: string): string {
    const baseUrl = this.configService.get<string>('webhook.baseUrl');
    const action = actionUrl || `${baseUrl}/webhook/gather?callSid=${callSid}`;
    const message = prompt || 'Please speak after the tone.';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather
    input="speech"
    action="${action}"
    speechTimeout="auto"
    language="en-US"
  >
    <Say>${this.escapeXml(message)}</Say>
  </Gather>
  <Say>I didn't receive any input. Goodbye!</Say>
</Response>`;
  }

  logWebhookEvent(dto: TwilioWebhookDto): void {
    this.logger.log(
      `Webhook received - CallSid: ${dto.CallSid}, Status: ${dto.CallStatus}, From: ${dto.From}, To: ${dto.To}`,
    );
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
