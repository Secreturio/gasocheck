// Fotos de tickets de "Mis repostajes" y foto de perfil. Son privadas: solo las ve su dueño, con su sesión.
// Se guardan comprimidas (el móvil las reduce antes de subirlas) en el almacén: fotos/<usuario>/<id>.<ext>
// y se borran al borrar el repostaje o la cuenta.

const MAX_BYTES = 900 * 1024; // tras la compresión en el móvil suelen ocupar 150–400 KB
const MAX_FOTOS = 500; // por cuenta
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const TIPOS = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
const DE_EXT = Object.fromEntries(Object.entries(TIPOS).map(([t, e]) => [e, t]));
const FIRMAS = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};
const fallo = (status, error) => ({ status, error });

export function crearFotos(almacen) {
  const dirDe = (usuarioId) => `fotos/${String(usuarioId).replace(/[^\w-]/g, '')}/`;
  const buscar = async (usuarioId, id) => {
    const k = (await almacen.listar(dirDe(usuarioId) + id + '.'))[0];
    return k ? { clave: k, tipo: DE_EXT[k.split('.').pop()] || 'image/jpeg' } : null;
  };

  return {
    // datos: "data:image/jpeg;base64,…"
    async guardar(u, id, datos) {
      if (!ID.test(String(id || ''))) return fallo(400, 'Identificador de foto no válido.');
      const m = String(datos || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return fallo(400, 'La foto debe ser JPEG, PNG o WebP.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_BYTES) return fallo(413, 'La foto es demasiado grande.');
      if (!FIRMAS[m[1]](buf)) return fallo(400, 'El archivo no es una imagen válida.');
      const existe = await buscar(u.id, id);
      if (!existe && (await almacen.listar(dirDe(u.id))).length >= MAX_FOTOS) return fallo(429, `Puedes guardar como mucho ${MAX_FOTOS} fotos de tickets.`);
      const clave = dirDe(u.id) + id + '.' + TIPOS[m[1]];
      await almacen.escribir(clave, buf);
      if (existe && existe.clave !== clave) await almacen.borrar(existe.clave);
      return { ok: true, bytes: buf.length };
    },
    async leer(u, id) {
      if (!ID.test(String(id || ''))) return null;
      const f = await buscar(u.id, id);
      if (!f) return null;
      const r = await almacen.leer(f.clave, { tipo: 'buffer' });
      return r ? { datos: r.datos, tipo: f.tipo } : null;
    },
    async borrar(u, id) {
      if (!ID.test(String(id || ''))) return fallo(400, 'Identificador de foto no válido.');
      const f = await buscar(u.id, id);
      if (f) await almacen.borrar(f.clave);
      return { ok: true };
    },
    async lista(u) {
      return (await almacen.listar(dirDe(u.id))).map((k) => k.slice(dirDe(u.id).length).replace(/\.\w+$/, ''));
    },
    async borrarTodas(usuarioId) {
      for (const k of await almacen.listar(dirDe(usuarioId))) await almacen.borrar(k);
    },
  };
}
