import type { EmailMessage, EmailProvider } from './types.js';

/**
 * Resend, over its HTTP API.
 *
 * No SDK for one endpoint. The failure path matters more than the happy one:
 * a send that fails must throw, so the caller can decide, rather than being
 * swallowed into a reset the user never receives and cannot explain.
 *
 * Untested against a live account — PayHive has no Resend domain yet — so the
 * first run against real credentials should be watched.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The address is not logged: it is the recipient of a security email and
      // has no business in an error string that may be aggregated elsewhere.
      throw new Error(`Resend rejected the message (${response.status}): ${detail.slice(0, 200)}`);
    }
  }
}
