import nodemailer from 'nodemailer';

let transport = null;
export const mailEnabled = () => !!process.env.SMTP_HOST;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function sendLink({ to, name, link, purpose }) {
  if (!mailEnabled()) return false;
  const convite = purpose === 'convite';
  const subject = convite ? 'Seu acesso ao Painel de Metas' : 'Redefinição de senha do Painel de Metas';
  const intro = convite
    ? 'Você foi cadastrado(a) no Painel de Metas. Clique no link abaixo para criar sua senha. O link vale por 7 dias.'
    : 'Recebemos um pedido para redefinir sua senha. Clique no link abaixo para criar uma nova. O link vale por 2 horas. Se não foi você, ignore este e-mail.';
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: `Olá, ${name}!\n\n${intro}\n\n${link}\n`,
    html: `<p>Olá, ${esc(name)}!</p><p>${esc(intro)}</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
  });
  return true;
}
