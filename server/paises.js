// Gasolineras de otros países de la Unión Europea (España va aparte, en estaciones.js).
//
// Solo algunos países publican en abierto los precios de cada gasolinera. Para cada uno hay un
// «adaptador» (server/paises/<código>.js) que descarga sus datos oficiales y los convierte al mismo
// formato que los de España: { id, rotulo, direccion, localidad, municipio, provincia, cp, horario,
// venta, lat, lng, precios: { gasolina95, gasolina98, gasoleoA, gasoleoPremium, glp } }.
//
// Las descargas se guardan en el almacén (estaciones/pais-<código>.json) y se renuevan cuando se piden
// y la copia es vieja, o desde la función programada para los países que alguien ha consultado hace poco.

import { NOMBRES_UE } from './paises/comun.js';
import francia from './paises/fr.js';
import italia from './paises/it.js';
import portugal from './paises/pt.js';
import { demoPais } from './paises/demo.js';

const ADAPTADORES = { fr: francia, it: italia, pt: portugal };
// Motivo por el que no hay datos de los demás países
const SIN_DATOS = 'No publica los precios de sus gasolineras en abierto';
const MOTIVOS = {
  at: 'Austria solo publica las 10 gasolineras más baratas de cada zona, no el listado completo',
  si: 'Eslovenia publica los precios, pero sin acceso automático gratuito',
  de: 'Alemania solo da precios con clave personal y por radio de 25 km, sin listado completo descargable',
  lu: 'Luxemburgo fija el mismo precio máximo para todo el país',
};

export function crearPaises(almacen, { demo = false } = {}) {
  const mem = new Map(); // código → { datos, comprobado }
  const enCurso = new Map();
  const pedidos = new Map(); // código → última vez que alguien lo pidió (para la función programada)

  const clave = (p) => `estaciones/pais-${p}.json`;
  const disponible = (p) => Boolean(ADAPTADORES[p] && (demo || ADAPTADORES[p].disponible?.() !== false));

  function listado() {
    const out = { es: { disponible: true, fuente: 'Ministerio para la Transición Ecológica' } };
    for (const c of Object.keys(NOMBRES_UE)) {
      if (c === 'es') continue;
      const a = ADAPTADORES[c];
      if (a && disponible(c)) out[c] = { disponible: true, fuente: a.fuente };
      else out[c] = { disponible: false, motivo: (a && a.motivoNoDisponible) || MOTIVOS[c] || SIN_DATOS };
    }
    return out;
  }

  async function descargar(p, { tiempoMax = 40_000 } = {}) {
    const a = ADAPTADORES[p];
    const estaciones = demo ? demoPais(p) : await a.descargar({ tiempoMax });
    if (!demo && estaciones.length < a.minimo) throw new Error(`${NOMBRES_UE[p]}: listado incompleto (${estaciones.length} gasolineras)`);
    const datos = { pais: p, fuente: a.fuente, licencia: a.licencia || '', fecha: fechaTexto(new Date()), descargado: Date.now(), demo: demo || undefined, estaciones };
    if (!demo) await almacen.escribir(clave(p), datos).catch((e) => console.error(`No se pudo guardar ${p}:`, e.message));
    mem.set(p, { datos, comprobado: Date.now() });
    return datos;
  }

  // Datos de un país: la copia guardada si es reciente; si no, se descargan (y si falla, la copia vieja)
  async function obtener(p) {
    if (!disponible(p)) throw Object.assign(new Error(`No hay datos de ${NOMBRES_UE[p] || p}.`), { status: 404 });
    pedidos.set(p, Date.now());
    const a = ADAPTADORES[p];
    const m = mem.get(p);
    if (m && Date.now() - m.datos.descargado < a.renovarMs && Date.now() - m.comprobado < 120_000) return m.datos;
    if (enCurso.has(p)) return enCurso.get(p);
    const tarea = (async () => {
      let copia = m?.datos || null;
      if (!demo && (!copia || Date.now() - m.comprobado >= 120_000)) {
        const r = await almacen.leer(clave(p), { tipo: 'json' }).catch(() => null);
        if (r?.datos) {
          copia = r.datos;
          mem.set(p, { datos: copia, comprobado: Date.now() });
        }
      }
      if (copia && Date.now() - copia.descargado < a.renovarMs) return copia;
      try {
        return await descargar(p);
      } catch (e) {
        console.error(`Descarga de ${p} fallida:`, e.message);
        if (copia) return { ...copia, desactualizado: true };
        throw e;
      }
    })().finally(() => enCurso.delete(p));
    enCurso.set(p, tarea);
    return tarea;
  }

  // Desde la función programada: renueva los países pedidos en la última semana cuya copia es vieja
  async function renovarPedidos({ tiempoMax = 8_000 } = {}) {
    if (demo) return [];
    const hechos = [];
    const t0 = Date.now();
    for (const p of Object.keys(ADAPTADORES)) {
      if (!disponible(p)) continue;
      const r = await almacen.leer(clave(p), { tipo: 'json' }).catch(() => null);
      if (!r?.datos) continue; // nadie lo ha pedido nunca
      if (Date.now() - r.datos.descargado < ADAPTADORES[p].renovarMs) continue;
      if (Date.now() - (r.datos.pedido || r.datos.descargado) > 7 * 86400_000 && !pedidos.has(p)) continue;
      if (Date.now() - t0 > tiempoMax) break;
      try {
        await descargar(p, { tiempoMax: Math.max(5_000, tiempoMax - (Date.now() - t0)) });
        hechos.push(p);
      } catch (e) {
        console.error(`Renovación de ${p} fallida:`, e.message);
      }
    }
    return hechos;
  }

  return { listado, obtener, renovarPedidos, disponible };
}

const fechaTexto = (d) =>
  new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '');
