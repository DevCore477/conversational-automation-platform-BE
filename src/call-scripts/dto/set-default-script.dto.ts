import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SetDefaultScriptSchema = z.object({
  scriptId: z.uuid('Invalid script ID'),
});

export class SetDefaultScriptDto extends createZodDto(SetDefaultScriptSchema) {}
