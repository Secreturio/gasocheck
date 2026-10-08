// Foto orientativa del coche del usuario (marca + modelo + año), sacada de Wikipedia / Wikimedia Commons.
// Es gratis y no necesita clave. Las fotos de Commons tienen licencia libre, pero hay que citar
// autor y licencia: se devuelven junto a la foto y la app los muestra debajo.
//
// El servidor hace de intermediario: busca, descarga la foto una vez y la guarda en el almacén (coches/),
// así el navegador del usuario no se conecta a Wikipedia y las siguientes veces es instantáneo.

import crypto from 'node:crypto';

const UA = 'GasoCheck/1.0 (https://gasocheck.es; gasochecklegal@gmail.com) foto-del-coche';
const MAX_BYTES = 3 * 1024 * 1024;
const NEGATIVO_MS = 24 * 3600 * 1000; // si no se encontró foto, no se vuelve a buscar en un día

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const sinHTML = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// "León 1.5 TSI FR" → "León"; "Clase C 220d" → "Clase C"; "Model 3" → "Model 3"; "208" → "208"
const MOTOR = /^(\d+[.,]\d+|\d+(cv|hp|kw|v)|tsi|tfsi|tdi|hdi|bluehdi|dci|tce|crdi|cdi|gdi|t-?gdi|puretech|ecoboost|ehybrid|e-?tech|hybrid|híbrido|hibrido|phev|hev|mhev|fr|xcellence|style|reference|sport|gt|gti|gtd|rs|st|amg|line|auto|automático|automatico|dsg|4x4|4motion|quattro|xdrive)$/i;
export function modeloBase(modelo) {
  const palabras = String(modelo || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of palabras) {
    if (out.length && MOTOR.test(p)) break;
    if (out.length && /\d/.test(p) && /^(\d+[a-z]?|[a-z]?\d+[a-z]?)$/i.test(p) && !/^(clase|serie|model|series)$/i.test(out[out.length - 1])) break;
    out.push(p);
    if (out.length === 2) break;
  }
  return out.join(' ');
}

export function crearFotoCoche(almacen, { fetchFn = globalThis.fetch } = {}) {
  const enCurso = new Map();

  const pedir = async (url, tipo = 'json') => {
    const r = await fetchFn(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return tipo === 'json' ? r.json() : r;
  };

  // Fotos de Wikimedia Commons de ese modelo y ese año: el nombre del archivo suele llevar el año
  // ("2018 SEAT Leon FR Front.jpg"). Así sale la generación de tu coche y no la última.
  const MALAS = /\b(interior|innenraum|cockpit|dashboard|salpicadero|armaturenbrett|engine|motorraum|badge|logo|emblem|wheel|wheels|rim|rims|llanta|steering|lenkrad|trunk|boot|kofferraum|maletero|headlight|headlights|taillight|lamp|faro|detail|details|key|gear|shifter|display|infotainment|mirror|handle|seats|toy|lego|diecast|miniature|scale|crash|accident|unfall|wreck|race|racing|rally|police|polizei|taxi|ambulance)\b/;
  const ALIAS = { volkswagen: ['volkswagen', 'vw'], 'mercedes-benz': ['mercedes', 'mercedes-benz'], 'land rover': ['land', 'landrover'], citroen: ['citroen'] };
  async function buscarCommons(marca, base, anio) {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${marca} ${base} ${anio}`, gsrnamespace: '6', gsrlimit: '30', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '960' })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const d = await pedir(u);
    const palabras = (t) => norm(t).replace(/^(file|archivo):/, '').replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    const clavesModelo = palabras(base);
    const nombresMarca = ALIAS[norm(marca)] || [palabras(marca)[0]];
    const y = Number(anio);
    let mejor = null;
    for (const p of Object.values(d?.query?.pages || {})) {
      const ii = p.imageinfo?.[0];
      if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime || 'image/jpeg')) continue;
      const titulo = norm(p.title);
      const ws = palabras(p.title);
      const set = new Set(ws);
      if (!clavesModelo.every((w) => set.has(w))) continue;
      if (!nombresMarca.some((m) => set.has(m) || titulo.includes(m))) continue;
      if (MALAS.test(ws.join(' '))) continue;
      // Nunca fotos de la parte de atrás
      if (/\b(rear|back|heck|hinten|heckansicht|trasera|trasero|arriere|posteriore|retro|tail)\b/.test(ws.join(' '))) continue;
      const anios = ws.filter((w) => /^(19[89]\d|20[0-3]\d)$/.test(w)).map(Number);
      let puntos = 0;
      if (anios.includes(y)) puntos += 6;
      else if (anios.some((a) => Math.abs(a - y) === 1)) puntos += 4;
      else if (anios.length) continue; // es de otro año (seguramente otra generación)
      if (set.has('front') || set.has('frontal') || set.has('vorne') || set.has('frente')) puntos += 2;
      puntos -= (p.index ?? 30) / 100; // a igualdad, lo que Commons pone antes
      if (puntos >= 3.5 && (!mejor || puntos > mejor.puntos)) mejor = { puntos, p, ii };
    }
    if (!mejor) return null;
    const m = mejor.ii.extmetadata || {};
    const nombre = mejor.p.title.replace(/^(File|Archivo):/, '').replace(/\.[A-Za-z0-9]+$/, '').replace(/_/g, ' ');
    return {
      url: mejor.ii.thumburl || mejor.ii.url,
      pagina: mejor.ii.descriptionurl || 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(mejor.p.title),
      autor: sinHTML(m.Artist?.value).slice(0, 120) || 'Autor desconocido',
      licencia: sinHTML(m.LicenseShortName?.value).slice(0, 60) || 'Licencia libre',
      articulo: nombre.slice(0, 90),
      articuloUrl: mejor.ii.descriptionurl || 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(mejor.p.title),
    };
  }

  async function buscar(marca, modelo, anio) {
    const base = modeloBase(modelo);
    // Solo una foto de ese modelo y ese año (o uno de diferencia) en Commons, de frente o de lado.
    // Si no la hay, no se pone ninguna: la del artículo de Wikipedia suele ser de otra generación.
    if (!anio) return null;
    return buscarCommons(marca, base, anio);
  }

  async function descargar(url, clave) {
    const r = await pedir(url, 'raw');
    const tipo = r.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)/.test(tipo)) throw new Error('No es una imagen');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Imagen demasiado grande');
    await almacen.escribir(clave, buf);
    return tipo.split(';')[0];
  }

  return {
    // { foto: { id, tipo, autor, licencia, pagina, articulo, articuloUrl } } o { foto: null }
    async obtener({ marca, modelo, anio }) {
      marca = String(marca || '').trim().slice(0, 30);
      modelo = String(modelo || '').trim().slice(0, 40);
      anio = /^(19[89]\d|20\d\d)$/.test(String(anio || '')) ? String(anio) : '';
      if (!marca || !modelo) return { foto: null, motivo: 'Indica la marca y el modelo.' };
      if (!anio) return { foto: null, motivo: 'Indica el año de tu coche para buscar una foto de su modelo.' };
      const clave = norm(`v4|${marca}|${modeloBase(modelo)}|${anio}`); // v3: busca la foto del año en Commons (descarta lo guardado antes)
      const id = crypto.createHash('sha1').update(clave).digest('hex').slice(0, 20);
      const fJson = `coches/${id}.json`;
      const c = (await almacen.leer(fJson, { tipo: 'json' }).catch(() => null))?.datos;
      if (c && (c.foto || Date.now() - c.fecha < NEGATIVO_MS)) return { foto: c.foto };
      if (enCurso.has(id)) return enCurso.get(id);
      const tarea = (async () => {
        let foto = null;
        try {
          const r = await buscar(marca, modelo, anio);
          if (r) {
            const tipo = await descargar(r.url, `coches/${id}.img`);
            foto = { id, tipo, autor: r.autor, licencia: r.licencia, pagina: r.pagina, articulo: r.articulo, articuloUrl: r.articuloUrl };
          }
        } catch (e) {
          console.warn('Foto del coche:', e.message);
          return { foto: null, motivo: 'No se pudo conectar con Wikipedia. Prueba más tarde.' }; // no se guarda: se reintentará
        }
        await almacen.escribir(fJson, { fecha: Date.now(), foto });
        return { foto };
      })().finally(() => enCurso.delete(id));
      enCurso.set(id, tarea);
      return tarea;
    },
    async imagen(id) {
      if (!/^[a-f0-9]{20}$/.test(String(id || ''))) return null;
      try {
        const c = (await almacen.leer(`coches/${id}.json`, { tipo: 'json' }))?.datos;
        if (!c?.foto) return null;
        const img = await almacen.leer(`coches/${id}.img`, { tipo: 'buffer' });
        return img ? { datos: img.datos, tipo: c.foto.tipo } : null;
      } catch {
        return null;
      }
    },
  };
}
