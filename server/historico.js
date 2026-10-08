// Historial de precios: una foto por día (la última descarga del día), 90 días.
// Se guarda en el almacén (Netlify Blobs o data/almacen en local):
//   historico/dias/AAAA-MM-DD.json            { dia, ids:[...], p:[gA, gP, g95, g98, ...], resumen }  (foto completa)
//   historico/trozos/AAAA-MM-DD/NN.json       la misma foto partida en 64 trozos por gasolinera, para que
//                                             la gráfica de una gasolinera solo descargue lo suyo
//   historico/resumenes.json                  medias diarias de España y de cada provincia
//   historico/variaciones.json                subidas y bajadas respecto a hace 7 días
// Lo escribe la actualización programada; las peticiones solo leen.

export const CLAVES = ['gasoleoA', 'gasoleoPremium', 'gasolina95', 'gasolina98'];
const K = CLAVES.length;
const DIAS_MAX = 90;
const TROZOS = 64;
const RESUMENES = 'historico/resumenes.json';
const VARIACIONES = 'historico/variaciones.json';
const CACHE_MS = 5 * 60 * 1000;

export const hoyMadrid = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);

export const trozoDe = (id) => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % TROZOS;
};

// Ejecuta tareas asíncronas con un máximo de N a la vez
export async function enParalelo(lista, n, fn) {
  const out = new Array(lista.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (i < lista.length) {
        const j = i++;
        out[j] = await fn(lista[j], j);
      }
    })
  );
  return out;
}

function medias(estaciones) {
  const acc = { n: {}, p: {} };
  const sumar = (obj, clave, v) => {
    const o = (obj[clave] ||= [0, 0]);
    o[0] += v;
    o[1]++;
  };
  for (const e of estaciones) {
    if (e.venta && e.venta !== 'publico') continue;
    for (const c of CLAVES) {
      const v = e.precios[c];
      if (v == null) continue;
      sumar(acc.n, c, v);
      sumar((acc.p[e.provincia] ||= {}), c, v);
    }
  }
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([c, [s, n]]) => [c, +(s / n).toFixed(4)]));
  return { n: fin(acc.n), p: Object.fromEntries(Object.entries(acc.p).map(([pr, o]) => [pr, fin(o)])) };
}

export function crearHistorico(almacen) {
  const cache = new Map(); // clave -> { t, datos }
  async function leerCache(clave, porDefecto) {
    const c = cache.get(clave);
    if (c && Date.now() - c.t < CACHE_MS) return c.datos;
    const r = await almacen.leer(clave, { tipo: 'json' }).catch(() => null);
    const datos = r?.datos ?? porDefecto;
    cache.set(clave, { t: Date.now(), datos });
    return datos;
  }

  return {
    // Guarda la foto del día (sustituye a la anterior del mismo día). Solo la llama la actualización.
    async registrar(datos, dia = hoyMadrid()) {
      const ids = [];
      const p = [];
      const trozos = Array.from({ length: TROZOS }, () => ({ ids: [], p: [] }));
      for (const e of datos.estaciones) {
        const fila = CLAVES.map((c) => e.precios[c] ?? null);
        ids.push(e.id);
        p.push(...fila);
        const t = trozos[trozoDe(e.id)];
        t.ids.push(e.id);
        t.p.push(...fila);
      }
      const resumen = medias(datos.estaciones);

      // Variaciones respecto a hace 7 fotos (antes de añadir la de hoy a la lista)
      const resumenes = (await almacen.leer(RESUMENES, { tipo: 'json' }))?.datos || {};
      resumenes[dia] = resumen;
      const orden = Object.keys(resumenes).sort();
      const viejos = orden.length > DIAS_MAX ? orden.slice(0, orden.length - DIAS_MAX) : [];
      for (const v of viejos) delete resumenes[v];
      const dias = orden.slice(viejos.length);

      await almacen.escribir(`historico/dias/${dia}.json`, { dia, ids, p, resumen });
      await enParalelo(trozos, 16, (t, i) => almacen.escribir(`historico/trozos/${dia}/${String(i).padStart(2, '0')}.json`, t));
      await almacen.escribir(RESUMENES, resumenes);

      let variaciones = {};
      if (dias.length >= 2) {
        const refDia = dias[Math.max(0, dias.length - 1 - 7)];
        const ref = refDia === dia ? null : (await almacen.leer(`historico/dias/${refDia}.json`, { tipo: 'json' }))?.datos;
        if (ref) {
          const pos = new Map(ref.ids.map((id, j) => [id, j]));
          ids.forEach((id, j) => {
            const r = pos.get(id);
            if (r === undefined) return;
            const v = {};
            let alguno = false;
            CLAVES.forEach((c, k) => {
              const a = p[j * K + k];
              const b = ref.p[r * K + k];
              if (a != null && b != null && Math.abs(a - b) > 1e-9) {
                v[c] = Math.round((a - b) * 1000) / 1000;
                alguno = true;
              }
            });
            if (alguno) variaciones[id] = v;
          });
        }
      }
      await almacen.escribir(VARIACIONES, { dias: 7, variaciones });
      cache.clear();

      // Borra los días que ya no entran en los 90
      for (const v of viejos) {
        const claves = [`historico/dias/${v}.json`, ...(await almacen.listar(`historico/trozos/${v}/`))];
        await enParalelo(claves, 16, (k) => almacen.borrar(k).catch(() => {}));
      }
      return dias.length;
    },

    // Serie de una gasolinera: [{dia, gasoleoA, ...}]
    async deEstacion(id) {
      const resumenes = await leerCache(RESUMENES, {});
      const dias = Object.keys(resumenes).sort();
      const t = String(trozoDe(id)).padStart(2, '0');
      const filas = await enParalelo(dias, 24, async (dia) => {
        const r = await almacen.leer(`historico/trozos/${dia}/${t}.json`, { tipo: 'json' }).catch(() => null);
        const d = r?.datos;
        if (!d) return null;
        const j = d.ids.indexOf(String(id));
        if (j < 0) return null;
        const fila = { dia };
        let alguno = false;
        CLAVES.forEach((c, k) => {
          const v = d.p[j * K + k];
          if (v != null) {
            fila[c] = Math.round(v * 1000) / 1000;
            alguno = true;
          }
        });
        return alguno ? fila : null;
      });
      return filas.filter(Boolean);
    },

    // Medias diarias, de España o de una provincia
    async tendencia(provincia) {
      const resumenes = await leerCache(RESUMENES, {});
      return Object.keys(resumenes)
        .sort()
        .map((dia) => {
          const r = resumenes[dia];
          return { dia, ...(provincia ? r.p[provincia] || {} : r.n) };
        });
    },

    // Variación de precio de cada gasolinera respecto a hace 7 días (para "ha bajado / ha subido")
    async variaciones() {
      return (await leerCache(VARIACIONES, { variaciones: {} })).variaciones || {};
    },

    async numDias() {
      return Object.keys(await leerCache(RESUMENES, {})).length;
    },
  };
}

// Solo para el modo demostración: inventa 60 días de historia con un paseo aleatorio
export async function sembrarDemo(historico, datos) {
  let semilla = 42;
  const rnd = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647);
  const hoy = new Date();
  // d = días atrás; en d = 0 la deriva es 0 para enlazar con los precios de hoy
  const deriva = Array.from({ length: 60 }, (_, d) => Math.sin(d / 9) * 0.03 + d * 0.0008);
  for (let d = 59; d >= 1; d--) {
    const fecha = new Date(hoy.getTime() - d * 86400000);
    const copia = {
      estaciones: datos.estaciones.map((e) => {
        const ruido = (rnd() - 0.5) * 0.02;
        const precios = {};
        for (const [c, v] of Object.entries(e.precios)) precios[c] = +(v + deriva[d] + ruido).toFixed(3);
        return { ...e, precios };
      }),
    };
    await historico.registrar(copia, hoyMadrid(fecha));
  }
}
