import { applyVariablesToDesign } from './message-builder.util';
import { csvRecordsToRecipients, parseCsvToRecords } from './csv-recipients.util';

describe('csv-recipients.util', () => {
  const csv = `phone,message,name,from,date,credit
+923001234567,Hi {{name}} — credit {{credit}} as of {{date}}.,Ali,HexaAI,2026-05-20,1500`;

  it('maps every non-phone column to row variables including name', () => {
    const records = parseCsvToRecords(csv);
    const [row] = csvRecordsToRecipients(records);
    expect(row.variables).toMatchObject({
      name: 'Ali',
      from: 'HexaAI',
      date: '2026-05-20',
      credit: '1500',
      message: expect.stringContaining('{{name}}'),
    });
  });

  it('resolves per-row message placeholders when design uses {{message}}', () => {
    const records = parseCsvToRecords(csv);
    const [recipient] = csvRecordsToRecipients(records);
    const rowVars = { ...recipient.variables, message: recipient.message };
    const design = applyVariablesToDesign({ type: 'text', body: '{{message}}' }, rowVars);
    expect(design).toEqual({
      type: 'text',
      body: 'Hi Ali — credit 1500 as of 2026-05-20.',
    });
  });

  it('preserves underscores in template variable column names', () => {
    const records = parseCsvToRecords(
      'phone,name,appointment_type,day,time\n+923001234567,Ali,Dental,Monday,4 PM',
    );
    const [row] = csvRecordsToRecipients(records);
    expect(row.variables).toMatchObject({
      name: 'Ali',
      appointment_type: 'Dental',
      day: 'Monday',
      time: '4 PM',
    });
  });

  it('resolves design body placeholders from CSV columns', () => {
    const records = parseCsvToRecords(csv);
    const [recipient] = csvRecordsToRecipients(records);
    const design = applyVariablesToDesign(
      {
        type: 'text',
        body: 'From {{from}}: Hi {{name}}, credit {{credit}} on {{date}}.',
      },
      recipient.variables,
    );
    expect(design.body).toBe('From HexaAI: Hi Ali, credit 1500 on 2026-05-20.');
  });
});
