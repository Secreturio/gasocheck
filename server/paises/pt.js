// Portugal: «Preços dos Combustíveis Online» (DGEG). Una fila por gasolinera y combustible.
import { bajar, coordOk, estacion, num, precioOk, titulo } from './comun.js';

const URL_DATOS = 'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos?qtdPorPagina=99999&pagina=1';
const VIEJO = 30 * 86400_000;
function clave(nombre) {
  const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (n === 'gasolina simples 95') return 'gasolina95';
  if (n === 'gasolina 98' || n === 'gasolina especial 98') return 'gasolina98';
  if (n === 'gasoleo simples') return 'gasoleoA';
  if (n === 'gasoleo especial') return 'gasoleoPremium';
  if (n === 'gpl auto') return 'glp';
  return null;
}

export function normalizarPortugal(filas) {
  const ahora = Date.now();
  const porId = new Map();
  for (const r of filas || []) {
    const id = r.Id ?? r.id_posto;
    const k = clave(r.Combustivel ?? r.combustivel);
    const p = precioOk(num(r.Preco ?? r.preco_texto));
    if (id == null || !k || p == null) continue;
    const t = Date.parse(String(r.DataAtualizacao ?? r.data_atualizacao ?? '').replace(' ', 'T'));
    if (Number.isFinite(t) && ahora - t > VIEJO) continue;
    let e = porId.get(id);
    if (!e) {
      const lat = Number(r.Latitude ?? r.latitude), lng = Number(r.Longitude ?? r.longitude);
      if (!coordOk(lat, lng)) continue;
      porId.set(id, (e = estacion({
        id: `pt-${id}`,
        rotulo: String(r.Marca ?? r.marca ?? '').trim() || 'Posto',
        nombre: String(r.Nome ?? r.nome ?? '').trim(),
        direccion: titulo(r.Morada ?? r.morada ?? ''),
        localidad: titulo(r.Localidade ?? r.localidade ?? ''),
        municipio: titulo(r.Municipio ?? r.concelho ?? ''),
        provincia: titulo(r.Distrito ?? r.distrito ?? ''),
        cp: String(r.CodPostal ?? r.cod_postal ?? ''),
        lat: Math.round(lat * 1e5) / 1e5,
        lng: Math.round(lng * 1e5) / 1e5,
        precios: {},
      })));
    }
    if (e.precios[k] == null || p < e.precios[k]) e.precios[k] = p;
  }
  return [...porId.values()];
}

export default {
  fuente: 'Direção-Geral de Energia e Geologia (DGEG)',
  licencia: 'Datos de precoscombustiveis.dgeg.gov.pt',
  renovarMs: 60 * 60_000,
  minimo: 1500,
  async descargar({ tiempoMax = 40_000 } = {}) {
    const d = await bajar(URL_DATOS, { tiempoMax });
    if (d && d.status === false) throw new Error('DGEG: ' + (d.mensagem || 'error'));
    return normalizarPortugal(d.resultado || d.Resultado || []);
  },
};
