import { BadRequestException, Body, Controller, Get, Logger, Patch, Post } from '@nestjs/common';

import { ElevenLabsTTSClient } from '../clients/elevenlabs/elevenlabs.client';

/** ElevenLabs integration (voices / platform agent config). Not the in-app `agents` CRUD module. */
@Controller('elevenlabs')
export class ElevenLabsController {
  private readonly logger = new Logger(ElevenLabsController.name);

  constructor(private readonly elevenLabsClient: ElevenLabsTTSClient) {}
  //
  // @Post('chat')
  // async chat(@Body() body: { text: string; conversationId?: string }) {
  //   const response = await this.elevenLabsClient.sendMessage(body.text, body.conversationId);
  //   return response;
  // }

  // @Post('stream')
  // async stream(@Body() body: { text: string; conversationId?: string }, @Res() res: Response) {
  //   const stream = await this.elevenLabsClient.streamMessage(body.text, body.conversationId);
  //
  //   res.setHeader('Content-Type', 'text/event-stream');
  //   res.setHeader('Cache-Control', 'no-cache');
  //   res.setHeader('Connection', 'keep-alive');
  //
  //   stream.pipe(res);
  // }

  @Get('voices')
  async getVoices() {
    this.logger.log('Fetching voices from ElevenLabs');
    const voicesWithDefault = await this.elevenLabsClient.getVoicesWithDefault();
    return voicesWithDefault;
  }

  /**
   * Make a voice usable for TTS. A no-op if `voiceId` is already in this account; otherwise looks
   * it up among voices already returned by GET /elevenlabs/voices (which includes Urdu/Hindi
   * shared-library results) and adds it to the account. Call this when a voice is selected/saved
   * for an agent so it never fails with `voice_id_does_not_exist` on the first real call.
   */
  @Post('voices/ensure-usable')
  async ensureVoiceUsable(@Body() body: { voiceId?: string; name?: string }) {
    const voiceId = body.voiceId?.trim();
    if (!voiceId) {
      throw new BadRequestException('voiceId is required');
    }
    const usableVoiceId = await this.elevenLabsClient.ensureVoiceUsable(voiceId, body.name);
    return { voiceId: usableVoiceId };
  }

  @Get('info')
  async getAgentInfo() {
    const agentInfo = await this.elevenLabsClient.getAgent();
    return agentInfo;
  }

  @Patch('info')
  async updateAgentInfo() {
    const updatedAgent = await this.elevenLabsClient.updateAgent();
    return updatedAgent;
  }
}
