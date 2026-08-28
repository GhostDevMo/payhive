import type { EmailMessage, EmailProvider } from './types.js';

/**
 * Development provider: prints the message instead of sending it.
 *
 * Keeps the whole reset flow exercisable with no account and no network — the
 * link is right there in the terminal. Tests use it too, and can read what was
 * "sent" through `sent`, which is the only way to assert on a token that is
 * deliberately never returned by the API.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  /** Everything sent this process. Test-only; not a queue and not durable. */
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `\n[payhive] email -> ${message.to}\n` +
          `          subject: ${message.subject}\n` +
          message.text
            .split('\n')
            .map((line) => `          ${line}`)
            .join('\n') +
          '\n',
      );
    }
  }
}
