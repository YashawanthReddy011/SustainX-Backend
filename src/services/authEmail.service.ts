import { env } from "../config/env";
import nodemailer, { type Transporter } from "nodemailer";

let smtpTransporter: Transporter | undefined;

function hasResendConfig() {
  return Boolean(env.authEmailApiKey && env.authEmailFrom);
}

function hasSmtpConfig() {
  return Boolean(env.smtpUser && env.smtpPass);
}

function getSmtpTransporter() {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
  }
  return smtpTransporter;
}

export function canDeliverAuthEmail() {
  return env.nodeEnv !== "production" || hasResendConfig() || hasSmtpConfig();
}

export async function sendAuthEmail(to: string, subject: string, text: string, link: string) {
  if (hasResendConfig()) {
    const response = await fetch(env.authEmailApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.authEmailApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.authEmailFrom, to: [to], subject, text }),
    });

    if (!response.ok) {
      throw new Error(`Authentication email provider returned HTTP ${response.status}.`);
    }
    return;
  }

  if (hasSmtpConfig()) {
    await getSmtpTransporter().sendMail({ from: env.authEmailFrom, to, subject, text });
    return;
  }

  if (!canDeliverAuthEmail()) {
    throw new Error("Authentication email delivery is not configured.");
  }

  if (env.nodeEnv !== "production") {
    console.info(`[auth email: development only] ${to}\n${subject}\n${link}`);
    return;
  }
}

export function verificationLink(token: string, next?: string) {
	const clientOrigin = env.clientUrl.replace(/\/+$/, "");
	let nextQuery = "";
	if (next && next.startsWith("/") && !next.startsWith("//")) {
		try {
			const base = new URL(clientOrigin);
			const target = new URL(next, base);
			if (target.origin === base.origin) {
				const returnPath = `${target.pathname}${target.search}${target.hash}`;
				nextQuery = `?next=${encodeURIComponent(returnPath)}`;
			}
		} catch {
			// Ignore invalid return paths and keep the normal verification destination.
		}
	}
	return `${clientOrigin}/verify-email${nextQuery}#token=${encodeURIComponent(token)}`;
}

export function passwordResetLink(token: string) {
	return `${env.clientUrl}/reset-password#token=${encodeURIComponent(token)}`;
}
