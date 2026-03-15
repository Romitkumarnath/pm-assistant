require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const smtpHost = required('SMTP_HOST');
  const smtpPort = Number(required('SMTP_PORT'));
  const smtpUser = required('SMTP_USER');
  const smtpPassword = required('SMTP_PASSWORD');
  const fromEmail = required('FROM_EMAIL');
  const fromName = process.env.FROM_NAME || 'Legal PMO';

  const toEmail = process.argv[2] || process.env.TO_EMAIL || smtpUser;
  const subject =
    process.env.EMAIL_SUBJECT || 'Lawyer Directory Open Bug Report (Frontend + Backend)';

  const draftPath =
    process.env.EMAIL_DRAFT_PATH ||
    path.join(__dirname, 'lawyer-directory-open-bugs-email-draft.txt');
  const reportPath =
    process.env.EMAIL_REPORT_PATH ||
    path.join(__dirname, 'lawyer-directory-open-bugs-report.md');
  const bodyPath = process.env.EMAIL_BODY_PATH || '';
  const bodyIsHtml =
    String(process.env.EMAIL_BODY_IS_HTML || '').toLowerCase() === 'true';
  const includeReportInBody =
    String(process.env.INCLUDE_REPORT_IN_BODY || '').toLowerCase() === 'true';
  const attachReport =
    String(process.env.ATTACH_REPORT || 'true').toLowerCase() !== 'false';

  if (!fs.existsSync(draftPath)) {
    throw new Error(`Email draft file not found: ${draftPath}`);
  }
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report file not found: ${reportPath}`);
  }

  const draftText = fs.readFileSync(draftPath, 'utf8').trim();
  const reportText = fs.readFileSync(reportPath, 'utf8').trim();
  let bodyText = draftText;
  let bodyHtml = null;
  if (draftText.toLowerCase().startsWith('subject:')) {
    const lines = draftText.split(/\r?\n/);
    bodyText = lines.slice(1).join('\n').trim();
  }
  if (includeReportInBody) {
    bodyText = `${bodyText}\n\n---\n\nFull report:\n\n${reportText}`;
  }
  if (bodyPath && fs.existsSync(bodyPath)) {
    const content = fs.readFileSync(bodyPath, 'utf8');
    if (bodyIsHtml) {
      bodyHtml = content;
      // Keep a minimal text body for mail clients.
      bodyText = bodyText || 'HTML report attached in body.';
    } else {
      bodyText = content;
    }
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPassword
    }
  });

  await transporter.verify();

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: toEmail,
    subject,
    text: bodyText,
    html: bodyHtml || undefined,
    attachments: attachReport
      ? [
          {
            filename: path.basename(reportPath),
            path: reportPath,
            contentType: 'text/markdown'
          }
        ]
      : []
  });

  console.log('Email sent successfully.');
  console.log(`To: ${toEmail}`);
  console.log(`Subject: ${subject}`);
  console.log(`Message ID: ${info.messageId}`);
}

main().catch((err) => {
  console.error('Failed to send email:', err.message);
  process.exit(1);
});
