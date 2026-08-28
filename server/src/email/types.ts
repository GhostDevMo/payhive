/**
 * The email seam.
 *
 * Same shape as the payment and bank-linking seams, for the same reason: the
 * provider is a supplier, not an architecture. Password reset is the first
 * thing that needs it, email verification is the second, and receipts will be
 * the third — none of them should know who sends the mail.
 *
 * Deliberately minimal. Anything a marketing tool does — templates, lists,
 * tracking pixels, unsubscribe management — is not here, because none of it
 * belongs on a message that lets someone back into their money.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Always required. HTML is an enhancement, never the only version. */
  text: string;
  html?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
