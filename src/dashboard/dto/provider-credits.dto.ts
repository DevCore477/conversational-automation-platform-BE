import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** ElevenLabs subscription / character usage from GET /v1/user/subscription */
export class ElevenLabsCreditsHealthDto {
  @ApiProperty({ enum: ['ok', 'unconfigured', 'error'] })
  status: 'ok' | 'unconfigured' | 'error';

  @ApiPropertyOptional({ description: 'Plan tier when status is ok' })
  tier?: string;

  @ApiPropertyOptional({ description: 'Characters used in the current billing period' })
  characterCount?: number;

  @ApiPropertyOptional({
    description: 'Character quota for the period (omit or null-style when unlimited)',
  })
  characterLimit?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Remaining characters in period; null when unlimited or unknown',
  })
  charactersRemaining?: number | null;

  @ApiPropertyOptional({
    description: 'Unix seconds when character count resets (when provided by API)',
  })
  nextCharacterCountResetUnix?: number;

  @ApiPropertyOptional({ description: 'Human-readable detail for unconfigured or error' })
  message?: string;
}

/** Twilio prepaid balance from Balance API */
export class TwilioCreditsHealthDto {
  @ApiProperty({ enum: ['ok', 'unconfigured', 'error'] })
  status: 'ok' | 'unconfigured' | 'error';

  @ApiPropertyOptional({ description: 'Balance amount as string (Twilio format)' })
  balance?: string;

  @ApiPropertyOptional({ example: 'USD' })
  currency?: string;

  @ApiPropertyOptional()
  message?: string;
}

export class TelnyxCreditsHealthDto {
  @ApiProperty({ enum: ['ok', 'unconfigured', 'error'] })
  status: 'ok' | 'unconfigured' | 'error';
  @ApiPropertyOptional({ description: 'Available credit as string' })
  availableCredit?: string;
  @ApiPropertyOptional({ description: 'Currency as string' })
  currency?: string;
  @ApiPropertyOptional()
  message?: string;
}

export class ProviderCreditsHealthDto {
  @ApiProperty({ type: ElevenLabsCreditsHealthDto })
  elevenLabs: ElevenLabsCreditsHealthDto;

  // @ApiProperty({ type: TwilioCreditsHealthDto })
  // twilio: TwilioCreditsHealthDto;

  @ApiProperty({ type: TelnyxCreditsHealthDto })
  telnyx: TelnyxCreditsHealthDto;
}
