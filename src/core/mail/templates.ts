import type { MailMessage } from './mail.types.js';

type Template = Omit<MailMessage, 'to'>;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(
  heading: string,
  body: string,
  url: string,
  cta: string,
): string {
  const safeUrl = escapeHtml(url);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>
<p style="line-height:1.5">${body}</p>
<p><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(cta)}</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${safeUrl}</p>
</body></html>`;
}

export function verifyEmailTemplate(input: {
  name: string;
  url: string;
  /** Human text for how long the link works, e.g. "24 hours" (comes from config). */
  expiresIn: string;
}): Template {
  return {
    subject: 'Confirm your email address',
    text: `Hi ${input.name},\n\nConfirm your email address: ${input.url}\n\nThe link expires in ${input.expiresIn}. If you did not create an account, ignore this email.`,
    html: layout(
      'Confirm your email',
      `Hi ${escapeHtml(input.name)}, confirm your email address to finish setting up your account. The link expires in ${escapeHtml(input.expiresIn)}.`,
      input.url,
      'Confirm email',
    ),
  };
}

export function resetPasswordTemplate(input: {
  name: string;
  url: string;
  /** Human text for how long the link works, e.g. "24 hours" (comes from config). */
  expiresIn: string;
}): Template {
  return {
    subject: 'Reset your password',
    text: `Hi ${input.name},\n\nReset your password: ${input.url}\n\nThe link expires in ${input.expiresIn} and works once. If you did not ask for this, ignore this email; your password has not changed.`,
    html: layout(
      'Reset your password',
      `Hi ${escapeHtml(input.name)}, use the button below to choose a new password. The link expires in ${escapeHtml(input.expiresIn)} and works once. If you did not ask for this, ignore this email.`,
      input.url,
      'Choose a new password',
    ),
  };
}

export function inviteTemplate(input: {
  inviterName: string;
  organizationName: string;
  role: string;
  url: string;
  expiresIn: string;
}): Template {
  const role = input.role.toLowerCase();
  return {
    subject: `${input.inviterName} invited you to ${input.organizationName}`,
    text: `${input.inviterName} invited you to join ${input.organizationName} as ${role}.\n\nAccept the invitation: ${input.url}\n\nThe link expires in ${input.expiresIn}. If you were not expecting this, ignore this email.`,
    html: layout(
      `Join ${input.organizationName}`,
      `${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(role)}. The link expires in ${escapeHtml(input.expiresIn)}.`,
      input.url,
      'Accept invitation',
    ),
  };
}

export function invoiceSentTemplate(input: {
  organizationName: string;
  clientName: string;
  number: string;
  amount: string;
  dueDate: string;
}): Template {
  const summary = `Invoice ${input.number} for ${input.amount}, due ${input.dueDate}.`;
  return {
    subject: `Invoice ${input.number} from ${input.organizationName}`,
    text: `Hi ${input.clientName},\n\n${input.organizationName} sent you an invoice.\n\n${summary}\n\nReply to this email if you have any questions.`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">Invoice ${escapeHtml(input.number)}</h2>
<p style="line-height:1.5">Hi ${escapeHtml(input.clientName)}, ${escapeHtml(input.organizationName)} sent you an invoice.</p>
<p style="line-height:1.5"><strong>${escapeHtml(input.amount)}</strong>, due ${escapeHtml(input.dueDate)}.</p>
<p style="color:#666;font-size:13px">Reply to this email if you have any questions.</p>
</body></html>`,
  };
}
