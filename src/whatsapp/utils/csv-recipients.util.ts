import { BadRequestException } from '@nestjs/common';

import { normalizePhoneNumber } from '../../common/utils/phone.util';
import type { BulkRecipientRow } from '../types/message-design.types';

/** Slugs after normalizing header text — all map to canonical `phone`. */
const PHONE_HEADER_SLUGS = new Set([
  'phone',
  'phonenumber',
  'phonenumbers',
  'phoneno',
  'phonenbr',
  'mobile',
  'mobilenumber',
  'mobileno',
  'cell',
  'cellphone',
  'cellnumber',
  'number',
  'contact',
  'contactnumber',
  'contactphone',
  'recipient',
  'recipientphone',
  'recipientnumber',
  'to',
  'whatsapp',
  'whatsappnumber',
  'whatsapno',
  'wa',
  'tel',
  'telephone',
  'telephonenumber',
]);

const MESSAGE_HEADER_SLUGS = new Set([
  'message',
  'body',
  'text',
  'content',
  'msg',
  'sms',
  'templatemessage',
]);

const NAME_HEADER_SLUGS = new Set(['name', 'fullname', 'contactname', 'firstname', 'customername']);

/**
 * Normalize CSV column headers: "Phone Number", "phone_numbers", etc. → canonical keys.
 */
export function normalizeCsvHeader(raw: string): string {
  const slug = raw
    .trim()
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/[^a-z0-9_]/g, '');

  if (!slug) {
    return '';
  }

  const compact = slug.replace(/_/g, '');

  if (PHONE_HEADER_SLUGS.has(compact)) {
    return 'phone';
  }
  if (MESSAGE_HEADER_SLUGS.has(compact)) {
    return 'message';
  }
  if (NAME_HEADER_SLUGS.has(compact)) {
    return 'name';
  }

  const paramMatch = compact.match(/^(?:param|parameter|templateparam|var)(\d+)$/);
  if (paramMatch) {
    return `param${paramMatch[1]}`;
  }

  return slug;
}

/** Parse CSV content into row objects (header row required). */
export function parseCsvToRecords(content: string): Array<Record<string, string>> {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new BadRequestException('CSV file is empty');
  }

  const rows = parseCsvRows(trimmed);
  if (rows.length < 2) {
    throw new BadRequestException('CSV must include a header row and at least one data row');
  }

  const headers = rows[0].map(h => normalizeCsvHeader(h));
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(cell => !cell.trim())) {
      continue;
    }
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) {
        return;
      }
      const value = (row[idx] ?? '').trim();
      if (!value) {
        return;
      }
      if (record[header] === undefined || record[header] === '') {
        record[header] = value;
      }
    });
    records.push(record);
  }

  if (records.length === 0) {
    throw new BadRequestException('CSV has no data rows');
  }

  return records;
}

/** All CSV column keys available for `{{placeholder}}` substitution (every column except phone). */
export function collectCsvVariableKeys(records: Record<string, string>[]): string[] {
  if (records.length === 0) {
    return [];
  }
  const phoneKey = findColumnKey(records[0], ['phone', ...PHONE_HEADER_SLUGS]);
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key && key !== phoneKey) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

export function csvRecordsToRecipients(records: Record<string, string>[]): BulkRecipientRow[] {
  const phoneKey = findColumnKey(records[0], ['phone', ...PHONE_HEADER_SLUGS]);
  if (!phoneKey) {
    throw new BadRequestException(
      'CSV must include a phone column (e.g. phone, Phone Number, mobile, whatsapp, to)',
    );
  }

  const messageKey = findColumnKey(records[0], ['message', ...MESSAGE_HEADER_SLUGS]);

  const recipients: BulkRecipientRow[] = [];

  for (const record of records) {
    const rawPhone = record[phoneKey];
    const to = normalizePhoneNumber(rawPhone);
    if (!to) {
      continue;
    }

    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === phoneKey || !value) {
        continue;
      }
      variables[key] = value;
    }

    const paramKeys = Object.keys(variables)
      .filter(k => /^param\d+$/i.test(k))
      .sort((a, b) => {
        const na = Number(a.replace(/\D/g, ''));
        const nb = Number(b.replace(/\D/g, ''));
        return na - nb;
      });

    const parameters =
      paramKeys.length > 0 ? paramKeys.map(k => variables[k]) : undefined;

    recipients.push({
      to,
      message: messageKey ? record[messageKey] : undefined,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
      parameters,
    });
  }

  if (recipients.length === 0) {
    throw new BadRequestException('No valid phone numbers found in CSV');
  }

  return recipients;
}

export const SAMPLE_CSV = `phone,message,name,from,date,credit
+923001234567,Hi {{name}} — credit {{credit}} as of {{date}}.,Ali,HexaAI,2026-05-20,1500
+923007654321,Hi {{name}} — credit {{credit}} as of {{date}}.,Sara,HexaAI,2026-05-20,2400
`;

function findColumnKey(
  record: Record<string, string>,
  candidates: Iterable<string>,
): string | undefined {
  const keys = Object.keys(record);
  for (const candidate of candidates) {
    const found = keys.find(k => k === candidate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** RFC 4180-style CSV row parser (handles quoted commas and newlines in quotes). */
function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(cell);
      cell = '';
      if (row.some(c => c.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      if (ch === '\r') {
        i++;
      }
    } else if (ch !== '\r') {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some(c => c.trim() !== '')) {
    rows.push(row);
  }

  return rows;
}
