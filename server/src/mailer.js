const nodemailer = require("nodemailer");

function isConfigured(env) {
  return !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);
}

async function sendSubmissionEmail(env, { to, subject, html }) {
  if (!isConfigured(env)) {
    console.log("\n[EMAIL NOT CONFIGURED] Would send email to:", to);
    console.log("Subject:", subject);
    console.log("HTML preview (first 400 chars):", String(html).slice(0, 400), "\n");
    return { ok: false, skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    secure: String(env.SMTP_SECURE).toLowerCase() === "true",
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to,
    subject,
    html,
  });
  return { ok: true, messageId: info.messageId };
}

module.exports = { sendSubmissionEmail, isConfigured };
