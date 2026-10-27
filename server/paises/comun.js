// Utilidades comunes a los adaptadores de países

export const NOMBRES_UE = {
  de: 'Alemania', at: 'Austria', be: 'Bélgica', bg: 'Bulgaria', cy: 'Chipre', hr: 'Croacia', dk: 'Dinamarca', sk: 'Eslovaquia',
  si: 'Eslovenia', es: 'España', ee: 'Estonia', fi: 'Finlandia', fr: 'Francia', gr: 'Grecia', hu: 'Hungría', ie: 'Irlanda',
  it: 'Italia', lv: 'Letonia', lt: 'Lituania', lu: 'Luxemburgo', mt: 'Malta', nl: 'Países Bajos', pl: 'Polonia', pt: 'Portugal',
  cz: 'República Checa', ro: 'Rumanía', se: 'Suecia',
};

export const UA = 'GasoCheck/2.3 (+https://gasocheck.netlify.app; gasocheck2026@gmail.com)';

// Precio razonable en €/l (descarta ceros y errores de tecleo)
export const precioOk = (n) => (Number.isFinite(n) && n > 0.3 && n < 5 ? Math.round(n * 1000) / 1000 : null);
export const num = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(String(s).replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
export const titulo = (s = '') =>
  String(s).trim().toLowerCase().replace(/(^|[\s(/'-])([\p{L}])/gu, (m, a, b) => a + b.toUpperCase());

// ¿Coordenadas dentro de Europa?
export const coordOk = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 27 && lat < 72 && lng > -32 && lng < 45 && !(lat === 0 && lng === 0);

// Descarga con tiempo máximo y User-Agent identificado
export async function bajar(url, { tiempoMax = 30_000, tipo = 'json', ...opts } = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: tipo === 'json' ? 'application/json' : '*/*', ...(opts.headers || {}) }, signal: AbortSignal.timeout(tiempoMax) });
  if (!r.ok) throw new Error(`${new URL(url).host} respondió ${r.status}`);
  return tipo === 'json' ? r.json() : tipo === 'buffer' ? Buffer.from(await r.arrayBuffer()) : r.text();
}

// Formato compacto: se omiten los campos vacíos o por defecto (el navegador los completa)
export const estacion = (o) => {
  const e = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v == null) continue;
    if (k === 'venta' && v === 'publico') continue;
    if (k === 'municipio' && v === o.localidad) continue;
    if (k === 'nombre' && v === o.rotulo) continue;
    e[k] = v;
  }
  return e;
};
