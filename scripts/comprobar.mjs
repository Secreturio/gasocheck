// Comprobación rápida antes de publicar en Netlify (se ejecuta con «npm run build»).
// Si falta algo imprescindible, el despliegue se para con un mensaje claro en vez de publicar una web rota.

import fs from 'node:fs';

const fallos = [];
const avisos = [];
const [mayor] = process.versions.node.split('.').map(Number);
if (mayor < 22) fallos.push(`Hace falta Node.js 22 o superior (hay ${process.versions.node}). Revisa NODE_VERSION en netlify.toml.`);

for (const f of ['public/index.html', 'public/app.js', 'public/sw.js', 'server/app.js', 'server/vendor/sql-wasm.mjs', 'server/vendor/sql-wasm-binario.js', 'netlify/functions/api.mjs', 'netlify/functions/actualizar.mjs']) {
  if (!fs.existsSync(f)) fallos.push(`Falta el fichero ${f}`);
}
if (!fs.existsSync('node_modules/@netlify/blobs')) fallos.push('No se instaló @netlify/blobs (revisa package.json).');

// Módulos del servidor: que carguen sin errores de sintaxis
try {
  await import('../server/app.js');
} catch (e) {
  fallos.push('El código del servidor tiene un error: ' + e.message);
}

if (!process.env.ADMIN_TOKEN) avisos.push('ADMIN_TOKEN no está definido: /admin.html (moderación) quedará desactivado.');
if (!process.env.RESEND_API_KEY || !process.env.CORREO_REMITENTE) avisos.push('Sin RESEND_API_KEY y CORREO_REMITENTE los correos (verificar cuenta, recuperar contraseña) no se envían: salen en el registro de la función.');
if (!process.env.REPORT_SALT) avisos.push('REPORT_SALT no está definido: conviene poner una cadena secreta cualquiera.');

for (const a of avisos) console.log('⚠️  ' + a);
if (fallos.length) {
  for (const f of fallos) console.error('❌ ' + f);
  process.exit(1);
}
console.log('✅ GasoCheck listo para publicar.');
