import nodemailer from "nodemailer";

export interface EmailSender {
  send(message: { subject: string; text: string }): Promise<void>;
}

// Created lazily inside the notify job so a missing SMTP config fails THAT run
// visibly (failed cadence_runs row) instead of crash-looping the worker at boot.
export function createSmtpSender(): EmailSender {
  const host = process.env.SMTP_HOST;
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM ?? "Mission Control <mission-control@localhost>";
  if (!host) throw new Error("SMTP_HOST not configured — email mirror cannot send");
  if (!to) throw new Error("MAIL_TO not configured — email mirror has no recipient");

  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });

  return {
    async send({ subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
