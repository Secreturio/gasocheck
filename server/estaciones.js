// Descarga y normaliza el listado oficial de precios del
// Ministerio para la Transición Ecológica (Geoportal de Gasolineras).
//
// En Netlify la descarga la hace la función programada cada 30 minutos (netlify/functions/actualizar.mjs)
// y el resultado se guarda en el almacén (estaciones/actual.json). Las peticiones de la web leen esa copia,
// así nunca esperan al Ministerio. Si todavía no hay copia (primer despliegue), se descarga en el momento.

import demoBruto from './demo-estaciones.js';

const URL_MINISTERIO =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';
const CLAVE = 'estaciones/actual.json';
const COMPROBAR_MS = 2 * 60 * 1000; // cada cuánto mira cada copia de la función si hay precios nuevos
const VIEJO_MS = 3 * 3600 * 1000; // a partir de aquí se marca como desactualizado

// Combustibles que mostramos. Clave corta -> campo del Ministerio
export const COMBUSTIBLES = {
  gasoleoA: 'Precio Gasoleo A',
  gasoleoPremium: 'Precio Gasoleo Premium',
  gasolina95: 'Precio Gasolina 95 E5',
  gasolina98: 'Precio Gasolina 98 E5',
  glp: 'Precio Gases licuados del petróleo',
};

const num = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const coord = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

const titulo = (s = '') =>
  s.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());

export function normalizar(bruto) {
  const estaciones = [];
  for (const e of bruto.ListaEESSPrecio || []) {
    const lat = coord(e['Latitud']);
    const lng = coord(e['Longitud (WGS84)']);
    if (lat === null || lng === null) continue;
    const precios = {};
    for (const [clave, campo] of Object.entries(COMBUSTIBLES)) {
      const p = num(e[campo]);
      if (p !== null) precios[clave] = p;
    }
    estaciones.push({
      id: String(e['IDEESS']),
      rotulo: (e['Rótulo'] || '').trim() || 'Sin marca',
      direccion: titulo(e['Dirección']),
      localidad: titulo(e['Localidad']),
      municipio: e['Municipio'] || '',
      provincia: titulo(e['Provincia']),
      cp: e['C.P.'] || '',
      horario: e['Horario'] || '',
      venta: e['Tipo Venta'] === 'R' ? 'restringida' : 'publico',
      lat,
      lng,
      precios,
    });
  }
  return { fecha: bruto.Fecha || '', fuente: 'Ministerio para la Transición Ecológica', estaciones };
}

// Descarga directa del Ministerio (con tiempo máximo, para no pasarse del límite de la función)
export async function descargarMinisterio({ tiempoMax = 25_000 } = {}) {
  const r = await fetch(URL_MINISTERIO, {
    headers: { Accept: 'application/json', 'User-Agent': 'GasoCheck/1.8 (+https://www.netlify.com)' },
    signal: AbortSignal.timeout(tiempoMax),
  });
  if (!r.ok) throw new Error(`El Ministerio respondió ${r.status}`);
  const bruto = await r.json();
  if (bruto.ResultadoConsulta && bruto.ResultadoConsulta !== 'OK') throw new Error(`Consulta no válida: ${bruto.ResultadoConsulta}`);
  const datos = normalizar(bruto);
  if (datos.estaciones.length < 1000) throw new Error(`Listado incompleto (${datos.estaciones.length} gasolineras)`);
  return datos;
}

export function crearEstaciones(almacen, { demo = false } = {}) {
  let mem = null; // { datos, etag, comprobado }
  let enCurso = null;
  let datosDemo = null;

  // Descarga del Ministerio y guarda la copia. Devuelve los datos nuevos.
  async function actualizar(opciones) {
    if (demo) return obtener();
    const datos = { ...(await descargarMinisterio(opciones)), descargado: Date.now() };
    const r = await almacen.escribir(CLAVE, datos);
    mem = { datos, etag: r.etag || null, comprobado: Date.now() };
    return datos;
  }

  async function leerCopia() {
    const r = await almacen.leer(CLAVE, { tipo: 'json', etag: mem?.etag || undefined });
    if (!r) return null;
    if (r.datos !== null) mem = { datos: r.datos, etag: r.etag || null, comprobado: Date.now() };
    else mem.comprobado = Date.now();
    return mem.datos;
  }

  async function obtener() {
    if (demo) {
      if (!datosDemo) datosDemo = { ...normalizar(demoBruto), demo: true, descargado: Date.now() };
      return datosDemo;
    }
    if (mem && Date.now() - mem.comprobado < COMPROBAR_MS) return marcar(mem.datos);
    if (enCurso) return enCurso;
    enCurso = (async () => {
      try {
        const copia = await leerCopia();
        if (copia) return marcar(copia);
        // Primer arranque: aún no ha corrido la actualización programada
        return await actualizar({ tiempoMax: 45_000 });
      } catch (err) {
        if (mem) return { ...mem.datos, desactualizado: true };
        throw err;
      }
    })().finally(() => {
      enCurso = null;
    });
    return enCurso;
  }

  const marcar = (d) => (d.descargado && Date.now() - d.descargado > VIEJO_MS ? { ...d, desactualizado: true } : d);

  // Milisegundos desde la última descarga del Ministerio (Infinity si no se sabe)
  const edad = () => (demo ? 0 : mem?.datos?.descargado ? Date.now() - mem.datos.descargado : Infinity);

  return { obtener, actualizar, edad, etag: () => mem?.etag || null };
}
