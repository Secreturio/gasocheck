// Envío de correos (verificación de cuenta, recuperar contraseña…).
// Con RESEND_API_KEY y CORREO_REMITENTE se envían de verdad mediante https://resend.com.
// Sin ellas, el correo se muestra en el registro de la función (Netlify → Logs → Functions → api)
// o en la consola si lo ejecutas en tu ordenador.
//
// Los correos se envían DESPUÉS de guardar la base de datos (ver app.js), para no mandar un enlace
// cuyo token no ha llegado a guardarse. Mientras dura una petición, enviar() solo los pone en cola.

export function crearCorreo() {
  const clave = process.env.RESEND_API_KEY || '';
  const remitente = process.env.CORREO_REMITENTE || '';
  const real = Boolean(clave && remitente);
  let cola = null;

  async function enviarYa({ para, asunto, texto }) {
    if (real) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: remitente, to: [para], subject: asunto, text: texto }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`El servicio de correo respondió ${r.status}`);
      return;
    }
    console.log(`\n=== CORREO (sin RESEND_API_KEY: no se envía) ${new Date().toISOString()}\nPara: ${para}\nAsunto: ${asunto}\n\n${texto}\n===\n`);
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
