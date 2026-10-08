// Almacén de ficheros del servidor. Netlify no tiene disco persistente, así que todo lo que antes
// iba a data/ (base de datos, historial, fotos…) se guarda aquí:
//  - En Netlify: Netlify Blobs (site-wide, consistencia fuerte). No hay que configurar nada.
//  - En tu ordenador (npm start): la carpeta data/almacen/, con la misma interfaz.
//
// Interfaz (todo asíncrono):
//   leer(clave, { tipo: 'json' | 'buffer' | 'texto', etag })  → null si no existe
//        → { datos, etag }   (datos === null si el etag que diste sigue siendo el actual)
//   escribir(clave, valor, { siEtag, siNuevo })   valor: Buffer | Uint8Array | string | objeto (JSON)
//        → { ok: true, etag } o { ok: false } si no se cumple la condición
//   borrar(clave), listar(prefijo) → [claves]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const aCuerpo = (valor) => {
  if (Buffer.isBuffer(valor)) return valor;
  if (valor instanceof Uint8Array) return Buffer.from(valor.buffer, valor.byteOffset, valor.byteLength);
  if (typeof valor === 'string') return Buffer.from(valor);
  return Buffer.from(JSON.stringify(valor));
};
const convertir = (buf, tipo) => (tipo === 'json' ? JSON.parse(buf.toString('utf8')) : tipo === 'texto' ? buf.toString('utf8') : buf);

/* ---------------- Netlify Blobs ---------------- */
async function almacenNetlify(nombre) {
  const { getStore } = await import('@netlify/blobs');
  // El contexto de Blobs llega con cada invocación: el store se abre en cada operación
  const tienda = () => getStore({ name: nombre, consistency: 'strong' });
  const tipoBlobs = (tipo) => (tipo === 'json' ? 'json' : tipo === 'texto' ? 'text' : 'arrayBuffer');
  return {
    tipo: 'netlify',
    async leer(clave, { tipo = 'json', etag } = {}) {
      const r = await tienda().getWithMetadata(clave, { type: tipoBlobs(tipo), ...(etag ? { etag } : {}) });
      if (!r) return null;
      if (r.data === null || r.data === undefined) return { datos: null, etag: r.etag };
      return { datos: tipo === 'buffer' ? Buffer.from(r.data) : r.data, etag: r.etag };
    },
    async escribir(clave, valor, { siEtag, siNuevo } = {}) {
      const cuerpo = aCuerpo(valor);
      // Se pasa un ArrayBuffer exacto (no el buffer compartido de Node)
      const ab = cuerpo.buffer.slice(cuerpo.byteOffset, cuerpo.byteOffset + cuerpo.byteLength);
      const op = siEtag ? { onlyIfMatch: siEtag } : siNuevo ? { onlyIfNew: true } : {};
      const r = await tienda().set(clave, ab, op);
      return r && r.modified === false ? { ok: false } : { ok: true, etag: r?.etag };
    },
    async borrar(clave) {
      await tienda().delete(clave);
    },
    async listar(prefijo = '') {
      const { blobs } = await tienda().list({ prefix: prefijo });
      return blobs.map((b) => b.key);
    },
  };
}

/* ---------------- Carpeta local (desarrollo) ---------------- */
let cerrojo = Promise.resolve(); // compartido por todo el proceso
function almacenDisco(carpeta) {
  const fichero = (clave) => path.join(carpeta, ...clave.split('/').map((p) => encodeURIComponent(p)));
  const etagDe = (buf) => '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
  async function escribirYa(clave, valor, { siEtag, siNuevo } = {}) {
    const f = fichero(clave);
    const cuerpo = aCuerpo(valor);
    if (siEtag || siNuevo) {
      let actual = null;
      try {
        actual = etagDe(await fs.promises.readFile(f));
      } catch {
        /* no existe */
      }
      if (siNuevo && actual) return { ok: false };
      if (siEtag && actual !== siEtag) return { ok: false };
    }
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fs.promises.writeFile(tmp, cuerpo);
    await fs.promises.rename(tmp, f);
    return { ok: true, etag: etagDe(cuerpo) };
  }

  return {
    tipo: 'disco',
    async leer(clave, { tipo = 'json', etag } = {}) {
      let buf;
      try {
        buf = await fs.promises.readFile(fichero(clave));
      } catch {
        return null;
      }
      const e = etagDe(buf);
      if (etag && etag === e) return { datos: null, etag: e };
      return { datos: convertir(buf, tipo), etag: e };
    },
    // Las escrituras condicionales se hacen de una en una (en Netlify Blobs las garantiza el servidor)
    escribir(clave, valor, opciones = {}) {
      const p = cerrojo.then(() => escribirYa(clave, valor, opciones));
      cerrojo = p.catch(() => {});
      return p;
    },
    async borrar(clave) {
      await fs.promises.rm(fichero(clave), { force: true });
    },
    async listar(prefijo = '') {
      const out = [];
      const recorrer = async (dir, base) => {
        let entradas;
        try {
          entradas = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entradas) {
          if (e.name.endsWith('.tmp')) continue;
          const clave = (base ? base + '/' : '') + decodeURIComponent(e.name);
          if (e.isDirectory()) await recorrer(path.join(dir, e.name), clave);
          else if (clave.startsWith(prefijo)) out.push(clave);
        }
      };
      await recorrer(carpeta, '');
      return out.sort();
    },
  };
}

// En Netlify se usa Blobs; en tu ordenador, la carpeta indicada
export async function crearAlmacen({ carpeta, netlify = false, nombre = 'gasocheck' } = {}) {
  if (netlify) return almacenNetlify(nombre);
  return almacenDisco(carpeta);
}
