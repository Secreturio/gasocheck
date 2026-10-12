// Envío de correos (verificación de cuenta, recuperar contraseña…).
// Con BREVO_API_KEY (o RESEND_API_KEY) y CORREO_REMITENTE se envían de verdad.
// Sin ellas, el correo se muestra en el registro de la función (Netlify → Logs → Functions → api)
// o en la consola si lo ejecutas en tu ordenador.
//
// Los correos se envían DESPUÉS de guardar la base de datos (ver app.js), para no mandar un enlace
// cuyo token no ha llegado a guardarse. Mientras dura una petición, enviar() solo los pone en cola.

// Proveedores (se usa el primero que tenga clave):
//   · Brevo  (https://brevo.com): BREVO_API_KEY + CORREO_REMITENTE. Gratis hasta 300 correos al día y
//     permite un remitente Gmail verificado, sin tener dominio propio.
//   · Resend (https://resend.com): RESEND_API_KEY + CORREO_REMITENTE (necesita un dominio propio verificado).
// CORREO_REMITENTE puede ser «correo@ejemplo.com» o «GasoCheck <correo@ejemplo.com>».
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Versión HTML sencilla del texto (enlaces pulsables y saltos de línea)
const aHTML = (texto) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b2333">${esc(texto)
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#2f7bf6">${u}</a>`)
    .replace(/\n/g, '<br>')}</div>`;

export function crearCorreo() {
  const brevo = process.env.BREVO_API_KEY || '';
  const resend = process.env.RESEND_API_KEY || '';
  const remitente = (process.env.CORREO_REMITENTE || '').trim();
  const m = remitente.match(/^\s*(?:"?([^"<]*?)"?\s*<)?\s*([^\s<>]+@[^\s<>]+)\s*>?\s*$/);
  const deNombre = (m?.[1] || 'GasoCheck').trim() || 'GasoCheck';
  const deCorreo = m?.[2] || '';
  const proveedor = deCorreo ? (brevo ? 'brevo' : resend ? 'resend' : null) : null;
  const real = Boolean(proveedor);
  if ((brevo || resend) && !deCorreo) console.warn('CORREO_REMITENTE falta o no es un correo válido: los correos no se envían.');
  let cola = null;

  async function enviarYa({ para, asunto, texto }) {
    if (proveedor === 'brevo') {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevo, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: deNombre, email: deCorreo },
          replyTo: { email: deCorreo, name: deNombre },
          to: [{ email: para }],
          subject: asunto,
          textContent: texto,
          htmlContent: aHTML(texto),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Brevo respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return;
    }
    if (proveedor === 'resend') {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${deNombre} <${deCorreo}>`, to: [para], subject: asunto, text: texto, html: aHTML(texto) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Resend respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return;
    }
    console.log(`\n=== CORREO (sin BREVO_API_KEY/RESEND_API_KEY: no se envía) ${new Date().toISOString()}\nPara: ${para}\nAsunto: ${asunto}\n\n${texto}\n===\n`);
  }

  return {
    real,
    async enviar(m) {
      if (cola) cola.push(m);
      else await enviarYa(m);
    },
    // Empieza a acumular (al principio de cada petición)
    empezar() {
      cola = [];
    },
    // Descarta lo acumulado (si la petición se repite)
    descartar() {
      if (cola) cola = [];
    },
    // Envía lo acumulado (tras guardar la base de datos)
    async vaciar() {
      const lista = cola || [];
      cola = null;
      for (const m of lista) await enviarYa(m).catch((e) => console.error('No se pudo enviar el correo:', e.message));
    },
  };
}
