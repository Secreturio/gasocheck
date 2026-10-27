// Francia: «Prix des carburants en France – Flux instantané v2» (Ministère de l'Économie).
// Licence Ouverte 2.0. Se renueva cada ~10 minutos en origen; aquí, como mucho cada 30.
// El fichero no trae la marca ni el nombre de la gasolinera: se completan con el listado abierto de
// hass-prixcarburant (id → nombre y marca), si se puede descargar.
import { bajar, coordOk, estacion, precioOk, titulo } from './comun.js';

const URL_DATOS = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json';
const CAMPOS = ['id', 'latitude', 'longitude', 'geom', 'cp', 'adresse', 'ville', 'departement', 'horaires_automate_24_24', 'gazole_prix', 'gazole_maj', 'sp95_prix', 'sp95_maj', 'e10_prix', 'e10_maj', 'sp98_prix', 'sp98_maj', 'gplc_prix', 'gplc_maj'];
const URL_NOMBRES = 'https://raw.githubusercontent.com/Aohzan/hass-prixcarburant/refs/heads/master/custom_components/prix_carburant/stations_name.json';
const VIEJO = 30 * 86400_000; // precios sin actualizar en 30 días: no se muestran

let nombres = { datos: null, cuando: 0 };
async function nombresEstaciones() {
  if (nombres.datos && Date.now() - nombres.cuando < 7 * 86400_000) return nombres.datos;
  try {
    nombres = { datos: await bajar(URL_NOMBRES, { tiempoMax: 15_000 }), cuando: Date.now() };
  } catch (e) {
    console.warn('Francia: sin nombres de gasolineras:', e.message);
  }
  return nombres.datos || {};
}

// Coordenadas: «geom» en grados; si no, latitude/longitude (a veces ×100000)
function coords(r) {
  if (r.geom && Number.isFinite(Number(r.geom.lat))) return [Number(r.geom.lat), Number(r.geom.lon)];
  let lat = Number(r.latitude), lng = Number(r.longitude);
  if (Math.abs(lat) > 1000) lat /= 100000;
  if (Math.abs(lng) > 1000) lng /= 100000;
  return [lat, lng];
}

export function normalizarFrancia(registros, nombresPorId = {}) {
  const ahora = Date.now();
  const out = [];
  for (const r of registros || []) {
    const [lat, lng] = coords(r);
    if (!coordOk(lat, lng)) continue;
    const vale = (k) => {
      const p = precioOk(Number(r[`${k}_prix`]));
      if (p == null) return null;
      const maj = Date.parse(r[`${k}_maj`] || '');
      return Number.isFinite(maj) && ahora - maj > VIEJO ? null : p;
    };
    const precios = {};
    const sp95 = vale('sp95') ?? vale('e10'); // muchas solo venden E10
    if (sp95 != null) precios.gasolina95 = sp95;
    if (vale('sp98') != null) precios.gasolina98 = vale('sp98');
    if (vale('gazole') != null) precios.gasoleoA = vale('gazole');
    if (vale('gplc') != null) precios.glp = vale('gplc');
    if (!Object.keys(precios).length) continue;
    const n = nombresPorId[String(r.id)] || {};
    const localidad = titulo(r.ville || '');
    out.push(estacion({
      id: `fr-${r.id}`,
      rotulo: (n.brand || '').trim() || 'Station',
      nombre: n.name || '',
      direccion: titulo(r.adresse || ''),
      localidad,
      provincia: r.departement || '',
      cp: String(r.cp || ''),
      horario: String(r.horaires_automate_24_24 || '').toLowerCase() === 'oui' ? 'L-D: 24H' : '',
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      precios,
    }));
  }
  return out;
}

export default {
  fuente: 'Ministère de l’Économie (prix-carburants.gouv.fr)',
  licencia: 'Licence Ouverte 2.0',
  renovarMs: 30 * 60_000,
  minimo: 5000,
  async descargar({ tiempoMax = 40_000 } = {}) {
    const url = `${URL_DATOS}?select=${encodeURIComponent(CAMPOS.join(','))}`;
    const [datos, nom] = await Promise.all([bajar(url, { tiempoMax }), nombresEstaciones()]);
    return normalizarFrancia(Array.isArray(datos) ? datos : datos.results || [], nom);
  },
};
