// Italia: «Carburanti – prezzi praticati e anagrafica degli impianti» (MIMIT). Licencia IODL 2.0.
// Dos CSV separados por «|» (antes «;»), con una primera línea «Estrazione del AAAA-MM-DD» y sin comillas.
// Se publica una vez al día (precios de las 8 de la mañana).
import { bajar, coordOk, estacion, precioOk, titulo } from './comun.js';

const BASE = 'https://www.mimit.gov.it/images/exportCSV/';
const CAB = { 'User-Agent': 'Mozilla/5.0 (compatible; GasoCheck/2.3; +https://gasocheck.netlify.app)', Referer: 'https://www.mimit.gov.it/' };
const VIEJO = 30 * 86400_000;

const PREMIUM_DIESEL = /BLUE DIESEL|SUPREME DIESEL|HI-?Q DIESEL|GASOLIO SPECIALE|GASOLIO PREMIUM|V-?POWER DIESEL|DIESEL SHELL V ?POWER|DIESELMAX|EXCELLIUM DIESEL|S-DIESEL|E-DIESEL|GP DIESEL|ORO DIESEL|GASOLIO PLUS|GASOLIO PRESTAZIONALE/;
const BENZINA_98 = /98|100|102|BLUE SUPER|HIQ PERFORM|V-?POWER$|BENZINA SHELL V ?POWER|WR 100/;
function clave(desc) {
  const d = String(desc || '').toUpperCase().trim();
  if (d === 'BENZINA') return 'gasolina95';
  if (d === 'GASOLIO') return 'gasoleoA';
  if (d === 'GPL') return 'glp';
  if (PREMIUM_DIESEL.test(d)) return 'gasoleoPremium';
  if (d.startsWith('BENZINA') || BENZINA_98.test(d)) return BENZINA_98.test(d) ? 'gasolina98' : null;
  return null;
}

const lineas = (txt) => txt.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
const sep = (cabecera) => (cabecera.includes('|') ? '|' : ';');
// dd/MM/yyyy HH:mm:ss → ms
const fecha = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : NaN;
};

export function normalizarItalia(txtAnagrafica, txtPrezzi) {
  const ahora = Date.now();
  // Precios: el de autoservicio si lo hay (suele ser el más barato)
  const precios = new Map();
  const lp = lineas(txtPrezzi);
  const ip = lp.findIndex((l) => /^idImpianto/i.test(l));
  const sp = sep(lp[ip] || '|');
  for (const l of lp.slice(ip + 1)) {
    const [id, desc, prezzo, isSelf, dt] = l.split(sp);
    const k = clave(desc);
    const p = precioOk(Number(prezzo));
    if (!k || p == null) continue;
    const t = fecha(dt);
    if (Number.isFinite(t) && ahora - t > VIEJO) continue;
    let e = precios.get(id);
    if (!e) precios.set(id, (e = {}));
    const self = isSelf === '1';
    const previo = e[k];
    if (!previo || (self && !previo.self) || (self === previo.self && p < previo.p)) e[k] = { p, self };
  }
  const out = [];
  const la = lineas(txtAnagrafica);
  const ia = la.findIndex((l) => /^idImpianto/i.test(l));
  const sa = sep(la[ia] || '|');
  for (const l of la.slice(ia + 1)) {
    const f = l.split(sa).map((x) => x.replace(/\t/g, ' ').trim());
    if (f.length < 10) continue;
    const id = f[0];
    // Las 5 últimas son siempre dirección, municipio, provincia, latitud y longitud
    const [indirizzo, comune, provincia, latS, lngS] = f.slice(-5);
    const it = f.findIndex((x, i) => i > 0 && /^(Stradale|Autostradale)$/i.test(x));
    const bandiera = it > 1 ? f[it - 1] : '';
    const lat = Number(latS), lng = Number(lngS);
    const p = precios.get(id);
    if (!p || !coordOk(lat, lng)) continue;
    const cp = (indirizzo.match(/\b(\d{5})\b(?!.*\b\d{5}\b)/) || [])[1] || '';
    const pr = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.p]));
    out.push(estacion({
      id: `it-${id}`,
      rotulo: bandiera && !/^pompe bianche$/i.test(bandiera) ? bandiera : 'Pompa bianca',
      direccion: titulo(indirizzo.replace(/\s+\d{5}\s*$/, '').replace(/,?\s*[^,]*\(\w{2}\)\s*$/, '').replace(/,?\s*\d{5}\s*$/, '').replace(/\s{2,}/g, ' ').trim()),
      localidad: titulo(comune),
      provincia: provincia.toUpperCase(),
      cp,
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      precios: pr,
      ...(it >= 0 && /^Autostradale$/i.test(f[it]) ? { autopista: true } : {}),
    }));
  }
  return out;
}

export default {
  fuente: 'Ministero delle Imprese e del Made in Italy (MIMIT)',
  licencia: 'IODL 2.0',
  renovarMs: 6 * 3600_000,
  minimo: 10000,
  async descargar({ tiempoMax = 40_000 } = {}) {
    const [a, p] = await Promise.all([
      bajar(BASE + 'anagrafica_impianti_attivi.csv', { tiempoMax, tipo: 'texto', headers: CAB }),
      bajar(BASE + 'prezzo_alle_8.csv', { tiempoMax, tipo: 'texto', headers: CAB }),
    ]);
    return normalizarItalia(a, p);
  },
};
