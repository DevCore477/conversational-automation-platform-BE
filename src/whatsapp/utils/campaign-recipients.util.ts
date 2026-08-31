import { BadRequestException } from '@nestjs/common';

import type { BulkRecipientRow } from '../types/message-design.types';
import type { CampaignRecipientInput } from '../types/campaign-recipient.types';
import { csvRecordsToRecipients, parseCsvToRecords } from './csv-recipients.util';

export function dedupeCampaignRecipients(
  recipients: CampaignRecipientInput[],
): CampaignRecipientInput[] {
  const seen = new Set<string>();
  const out: CampaignRecipientInput[] = [];

  for (const r of recipients) {
    const key = r.phone.replace(/\s/g, '');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(r);
  }

  return out;
}

export function bulkRowsToCampaignRecipients(rows: BulkRecipientRow[]): CampaignRecipientInput[] {
  return rows.map(row => ({
    phone: row.to,
    name: row.variables?.name ?? row.variables?.Name,
    templateParams: row.parameters,
    variables: row.variables,
  }));
}

export function parseCampaignCsv(buffer: Buffer): CampaignRecipientInput[] {
  const content = buffer.toString('utf8');
  const records = parseCsvToRecords(content);
  return bulkRowsToCampaignRecipients(csvRecordsToRecipients(records));
}

export function normalizeRecipientList(
  recipients?: CampaignRecipientInput[],
  phones?: string[],
): CampaignRecipientInput[] {
  const fromPhones =
    phones?.map(p => ({ phone: p })) ?? [];
  const combined = dedupeCampaignRecipients([...(recipients ?? []), ...fromPhones]);

  if (combined.length === 0) {
    throw new BadRequestException(
      'Provide recipients (phone numbers), phones array, or upload a CSV with a phone column',
    );
  }

  return combined;
}
