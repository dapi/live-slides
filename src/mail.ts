import nodemailer, { type Transporter } from "nodemailer";
import { config, secret } from "./config";

/**
 * Outgoing mail for sign-in codes. One SMTP account, the sender in MAIL_FROM; the password
 * arrives by environment or a named pass entry and is never written anywhere else.
 */
export class Mail {
  private transport: Promise<Transporter> | null = null;

  get enabled(): boolean {
    return Boolean(config.mail.smtpUrl && config.mail.from && (process.env[config.mail.passwordEnv] || config.mail.passwordPassEntry));
  }

  private async open(): Promise<Transporter> {
    const url = new URL(config.mail.smtpUrl);
    const password = await secret(config.mail.passwordEnv, config.mail.passwordPassEntry);
    return nodemailer.createTransport({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)),
      secure: url.protocol === "smtps:",
      auth: { user: decodeURIComponent(url.username), pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.enabled) throw new Error("Почта не настроена");
    this.transport ??= this.open();
    const transport = await this.transport.catch((error) => { this.transport = null; throw error; });
    await transport.sendMail({ from: config.mail.from, to, subject, text });
  }
}
