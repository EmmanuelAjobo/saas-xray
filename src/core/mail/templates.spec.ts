import {
  inviteTemplate,
  invoiceSentTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
} from './templates.js';

const url = 'http://localhost:3001/verify-email?token=abc_DEF-123';
const expiresIn = '24 hours';

describe('email templates', () => {
  it.each([
    ['verify', verifyEmailTemplate],
    ['reset', resetPasswordTemplate],
  ])(
    '%s: the link appears in both the text and HTML versions',
    (_n, template) => {
      const mail = template({ name: 'Ada', url, expiresIn });
      expect(mail.text).toContain(url);
      expect(mail.html).toContain(`href="${url}"`);
      expect(mail.subject.length).toBeGreaterThan(5);
    },
  );

  it('escapes a hostile display name so it cannot inject HTML', () => {
    const name = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const { html } = verifyEmailTemplate({ name, url, expiresIn });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the URL attribute so a crafted link cannot break out of href', () => {
    const { html } = resetPasswordTemplate({
      name: 'Ada',
      url: 'http://x.test/?a=1" onclick="alert(1)',
      expiresIn,
    });
    expect(html).not.toContain('" onclick="');
    expect(html).toContain('&quot; onclick=&quot;');
  });

  it('states the expiry it is given (the caller derives it from the configured lifetime)', () => {
    const verify = verifyEmailTemplate({ name: 'A', url, expiresIn: '2 days' });
    const reset = resetPasswordTemplate({
      name: 'A',
      url,
      expiresIn: '30 minutes',
    });
    expect(verify.text).toContain('expires in 2 days');
    expect(verify.html).toContain('expires in 2 days');
    expect(reset.text).toContain('expires in 30 minutes');
    expect(reset.html).toContain('expires in 30 minutes');
  });

  it('escapes the expiry text too', () => {
    const { html } = verifyEmailTemplate({
      name: 'A',
      url,
      expiresIn: '<b>soon</b>',
    });
    expect(html).not.toContain('<b>soon</b>');
  });

  describe('invitation email', () => {
    const base = {
      inviterName: 'Ada',
      organizationName: 'Acme Studio',
      role: 'ADMIN',
      url,
      expiresIn: '7 days',
    };

    it('names the inviter, the organisation, the role, the link and the expiry in both versions', () => {
      const mail = inviteTemplate(base);
      expect(mail.subject).toBe('Ada invited you to Acme Studio');
      for (const body of [mail.text, mail.html]) {
        expect(body).toContain('Acme Studio');
        expect(body).toContain('admin');
        expect(body).toContain('7 days');
      }
      expect(mail.text).toContain(url);
      expect(mail.html).toContain(`href="${url}"`);
    });

    it('escapes a hostile organisation name and inviter name in the HTML', () => {
      const { html } = inviteTemplate({
        ...base,
        inviterName: '<img src=x onerror=alert(1)>',
        organizationName: '<script>alert(2)</script>',
      });
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('invoice email', () => {
    const base = {
      organizationName: 'Acme Studio',
      clientName: 'Northwind',
      number: 'INV-0042',
      amount: '$986.00',
      dueDate: '2026-12-31',
    };

    it('states the number, amount, due date and who sent it, in both versions', () => {
      const mail = invoiceSentTemplate(base);
      expect(mail.subject).toBe('Invoice INV-0042 from Acme Studio');
      for (const body of [mail.text, mail.html]) {
        expect(body).toContain('INV-0042');
        expect(body).toContain('$986.00');
        expect(body).toContain('2026-12-31');
        expect(body).toContain('Acme Studio');
      }
    });

    it('escapes hostile names in the HTML', () => {
      const { html } = invoiceSentTemplate({
        ...base,
        organizationName: '<script>alert(1)</script>',
        clientName: '<img src=x onerror=alert(2)>',
      });
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img');
    });
  });
});
