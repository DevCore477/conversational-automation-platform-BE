import {
  extractPlaceholderKeys,
  findMissingPlaceholderKeys,
  renderPlaceholders,
} from './placeholder.util';

describe('placeholder.util', () => {
  it('extracts placeholder keys from text', () => {
    expect(extractPlaceholderKeys('Hi {{name}}, credit {{credit}} on {{date}}.')).toEqual([
      'name',
      'credit',
      'date',
    ]);
  });

  it('substitutes variables case-insensitively', () => {
    const out = renderPlaceholders('Hi {{Name}}!', { name: 'Ali' });
    expect(out).toBe('Hi Ali!');
  });

  it('resolves nested placeholders via message column pattern', () => {
    const vars = {
      name: 'Ali',
      credit: '1500',
      date: '2026-05-20',
      message: 'Hi {{name}} — credit {{credit}} as of {{date}}.',
    };
    const out = renderPlaceholders('{{message}}', vars);
    expect(out).toBe('Hi Ali — credit 1500 as of 2026-05-20.');
  });

  it('reports unresolved placeholders', () => {
    expect(findMissingPlaceholderKeys('Hi {{name}}', { phone: '1' })).toEqual(['name']);
  });
});
