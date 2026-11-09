import { redactEmails, safeErrorMessage } from './redact.js';

describe('redactEmails', () => {
  it.each([
    ['550 rejected jane@client.com', '550 rejected [email]'],
    ['to <jane.doe+tag@sub.client.co.uk>: bounced', 'to <[email]>: bounced'],
    ['a@b.io and c@d.org', '[email] and [email]'],
    ['("x@y.com")', '("[email]")'],
  ])('%s', (input, expected) => {
    expect(redactEmails(input)).toBe(expected);
  });

  it('leaves text without an address alone', () => {
    expect(redactEmails('connect ECONNREFUSED 10.0.0.1:587')).toBe(
      'connect ECONNREFUSED 10.0.0.1:587',
    );
    expect(redactEmails('')).toBe('');
  });

  it('does not treat an @-mention or a lone @ as an address', () => {
    expect(redactEmails('ping @team about it')).toBe('ping @team about it');
    expect(redactEmails('user@host')).toBe('user@host');
  });
});

describe('safeErrorMessage', () => {
  it('redacts the message of an Error', () => {
    expect(safeErrorMessage(new Error('550 no such user bob@x.com'))).toBe(
      '550 no such user [email]',
    );
  });
  it('copes with a thrown string or something odd', () => {
    expect(safeErrorMessage('failed for bob@x.com')).toBe('failed for [email]');
    expect(safeErrorMessage(undefined)).toBe('undefined');
  });
});
