// Compartir el viaje en directo: quien navega envía su posición cada pocos segundos y quien tiene el
// enlace la ve en un mapa (public/viaje.html). No usa la base de datos: cada viaje es un fichero del
// almacén (viajes/<id>.json) que caduca a las 8 horas o al terminar la navegación.

import crypto from 'node:crypto';

const DURA_MS = 8 * 3600 * 1000;
const ID = /^[A-Za-z0-9_-]{12,24}$/;
const fallo = (status, error) => ({ status, error });
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export function crearViajes(almacen) {
  const creados = new Map(); // ip -> [tiempos] (límite: 10 por hora)
  const clave = (id) => `viajes/${id}.json`;
  const leer = async (id) => (ID.test(id) ? (await almacen.leer(clave(id), { tipo: 'json' }).catch(() => null))?.datos : null);

  return {
    async crear(body, { ip, usuario }) {
      const ahora = Date.now();
      const lista = (creados.get(ip) || []).filter((t) => ahora - t < 3600 * 1000);
      if (lista.length >= 10) return fallo(429, 'Has compartido muchos viajes en poco tiempo. Prueba más tarde.');
      lista.push(ahora);
      creados.set(ip, lista);
      const d = body.destino || {};
      const lat = num(d.lat, 27, 44.5), lng = num(d.lng, -19, 5);
      if (lat == null || lng == null) return fallo(400, 'Falta el destino del viaje.');
      const id = crypto.randomBytes(12).toString('base64url');
      const secreto = crypto.randomBytes(18).toString('base64url');
      await almacen.escribir(clave(id), {
        creado: ahora,
        expira: ahora + DURA_MS,
        clave: hash(secreto),
        quien: String(usuario?.alias || body.alias || 'Un conductor').slice(0, 40),
        destino: { nombre: String(d.nombre || 'Destino').slice(0, 80), lat, lng },
        pos: null,
        terminado: false,
      });
      return { id, clave: secreto };
    },

    async actualizar(id, body) {
      const v = await leer(id);
      if (!v || v.expira < Date.now()) return fallo(404, 'Este viaje ya no se comparte.');
      if (hash(body.clave) !== v.clave) return fallo(403, 'No puedes actualizar este viaje.');
      if (body.fin) {
        v.terminado = true;
        v.expira = Math.min(v.expira, Date.now() + 15 * 60 * 1000); // el enlace muestra «ha llegado» un rato
      } else {
        const lat = num(body.lat, 27, 44.5), lng = num(body.lng, -19, 5);
        if (lat == null || lng == null) return fallo(400, 'Posición no válida.');
        v.pos = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, rumbo: num(body.rumbo, -360, 720), t: Date.now() };
        v.eta = num(body.eta, Date.now() - 3600e3, Date.now() + 48 * 3600e3);
        v.restoKm = num(body.restoKm, 0, 3000);
        if (body.llegado) v.terminado = true;
      }
      await almacen.escribir(clave(id), v);
      return { ok: true };
    },

    async ver(id) {
      const v = await leer(id);
      if (!v || v.expira < Date.now()) return fallo(404, 'Este viaje ya no se está compartiendo.');
      const { clave: _, ...publico } = v;
      return publico;
    },

    // Mantenimiento: borra los viajes caducados
    async limpiar() {
      for (const k of await almacen.listar('viajes/')) {
        const v = (await almacen.leer(k, { tipo: 'json' }).catch(() => null))?.datos;
        if (!v || v.expira < Date.now() - 3600 * 1000) await almacen.borrar(k).catch(() => {});
      }
    },
  };
}
