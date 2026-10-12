// Copia todos los datos de GasoCheck (Netlify Blobs, store «gasocheck») de un proyecto de Netlify a otro:
// cuentas, valoraciones, repostajes sincronizados, fotos y facturas, historial de precios, avisos, copias…
// Se ejecuta desde GitHub (Actions → «Migrar datos de Netlify») con estos secretos del repositorio:
//   NETLIFY_TOKEN_VIEJO, SITE_ID_VIEJO  → cuenta y proyecto antiguos
//   NETLIFY_TOKEN_NUEVO, SITE_ID_NUEVO  → cuenta y proyecto nuevos
// Con PRUEBA=1 solo cuenta lo que hay, sin copiar nada.
import { getStore } from '@netlify/blobs';

const STORE = process.env.STORE || 'gasocheck';
const PRUEBA = process.env.PRUEBA === '1';
const falta = ['NETLIFY_TOKEN_VIEJO', 'SITE_ID_VIEJO', 'NETLIFY_TOKEN_NUEVO', 'SITE_ID_NUEVO'].filter((k) => !process.env[k]?.trim());
if (falta.length) {
  console.error(`❌ Faltan estos secretos en GitHub: ${falta.join(', ')}`);
  process.exit(1);
}
if (process.env.SITE_ID_VIEJO.trim() === process.env.SITE_ID_NUEVO.trim()) {
  console.error('❌ SITE_ID_VIEJO y SITE_ID_NUEVO son iguales: tienen que ser dos proyectos distintos.');
  process.exit(1);
}
const abrir = (sufijo) => getStore({ name: STORE, siteID: process.env['SITE_ID_' + sufijo].trim(), token: process.env['NETLIFY_TOKEN_' + sufijo].trim(), consistency: 'strong' });
const viejo = abrir('VIEJO');
const nuevo = abrir('NUEVO');

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const { blobs } = await viejo.list();
const claves = blobs.map((b) => b.key).sort();
const grupos = {};
for (const k of claves) grupos[k.split('/')[0]] = (grupos[k.split('/')[0]] || 0) + 1;
console.log(`Proyecto antiguo: ${claves.length} elementos`);
for (const [g, n] of Object.entries(grupos)) console.log(`  · ${g}: ${n}`);
if (!claves.length) {
  console.error('❌ El proyecto antiguo no tiene datos. Revisa SITE_ID_VIEJO y NETLIFY_TOKEN_VIEJO.');
  process.exit(1);
}
if (PRUEBA) {
  console.log('\nModo prueba: no se ha copiado nada. Ejecútalo de nuevo con «prueba» desmarcado para copiar.');
  process.exit(0);
}

// La base de datos va la última, para que lo demás (fotos, etc.) ya esté cuando la app la lea
const orden = [...claves.filter((k) => !/^bd\b|\.sqlite$|^db\b/.test(k)), ...claves.filter((k) => /^bd\b|\.sqlite$|^db\b/.test(k))];
let copiados = 0, bytes = 0;
const fallos = [];
for (const k of orden) {
  try {
    const r = await viejo.getWithMetadata(k, { type: 'arrayBuffer' });
    if (!r) continue;
    await nuevo.set(k, r.data, r.metadata && Object.keys(r.metadata).length ? { metadata: r.metadata } : {});
    copiados++;
    bytes += r.data.byteLength;
    if (copiados % 50 === 0) console.log(`  … ${copiados}/${orden.length}`);
  } catch (e) {
    fallos.push(`${k}: ${e.message}`);
  }
}
// Comprobación: todo lo del antiguo está en el nuevo
const { blobs: enNuevo } = await nuevo.list();
const nuevoSet = new Set(enNuevo.map((b) => b.key));
const sinCopiar = claves.filter((k) => !nuevoSet.has(k));
console.log(`\n✅ Copiados ${copiados} elementos (${kb(bytes)}) al proyecto nuevo.`);
if (fallos.length || sinCopiar.length) {
  console.error(`⚠️ ${fallos.length} fallos y ${sinCopiar.length} sin copiar:`);
  for (const f of [...fallos, ...sinCopiar].slice(0, 30)) console.error('   ' + f);
  console.error('Vuelve a ejecutarlo: lo que ya está copiado se sobrescribe sin problema.');
  process.exit(1);
}
console.log('Todo comprobado. Ya puedes poner el nombre «gasocheck» al proyecto nuevo.');
