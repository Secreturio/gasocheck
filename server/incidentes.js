// Incidentes de tráfico avisados por los conductores desde el GPS (como Waze):
// accidentes, atascos, controles, obras, peligros en la vía…
// - Cada aviso caduca solo (según el tipo) y se alarga cuando otros conductores confirman que sigue ahí.
// - Al pasar, se pregunta a los demás conductores si sigue ahí: con 3 «ya no está», desaparece.
// - Quien lo avisó puede cambiar el tipo o quitarlo (con su cuenta o con la clave que recibe al crearlo).
// - Límites para evitar abusos: un aviso cada 2 minutos y 30 al día por persona; no se repite el mismo
//   incidente si ya hay uno igual a menos de 300 m (en ese caso cuenta como confirmación).
// - La reputación cuenta: los avisos de cuentas poco fiables duran la mitad, y el «ya no está» de un
//   conductor fiable pesa el doble. Con 3 confirmaciones o más, el aviso se marca como confirmado.

import crypto from 'node:crypto';
import { huella } from './reportes.js';

const MIN = 60 * 1000;
export const TIPOS = {
  accidente: { nombre: 'Accidente', dura: 90 * MIN },
  atasco: { nombre: 'Atasco', dura: 45 * MIN },
  control: { nombre: 'Control policial', dura: 90 * MIN },
  radar: { nombre: 'Radar móvil', dura: 90 * MIN },
  obras: { nombre: 'Obras', dura: 12 * 60 * MIN },
  peligro: { nombre: 'Peligro en la vía', dura: 60 * MIN },
  averiado: { nombre: 'Vehículo parado', dura: 45 * MIN },
  tiempo: { nombre: 'Mal tiempo', dura: 3 * 60 * MIN },
};
const MAX_VIDA = 24 * 60 * MIN;
const NEGACIONES_BORRAR = 3; // conductores distintos que dicen «ya no está»
const fallo = (status, error) => ({ status, error });

const distM = (a, b) => {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111320;
};

export function crearIncidentes(db, reputacion = null) {
  const nuevoId = () => crypto.randomBytes(9).toString('base64url');
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');
  const publico = (f, quien = null, clave = null) => ({
    id: f.id, tipo: f.tipo, nombre: TIPOS[f.tipo]?.nombre || f.tipo, lat: f.lat, lng: f.lng, rumbo: f.rumbo, creado: f.creado, expira: f.expira,
    confirmaciones: f.confirmaciones, negaciones: f.negaciones || 0, confirmado: f.confirmaciones >= 3,
    mio: Boolean((quien && f.quien === quien) || (clave && f.clave && sha(clave) === f.clave)),
  });
  const quienDe = ({ ip, usuario }) => (usuario ? 'u:' + usuario.id : 'ip:' + huella(ip));
  // ¿Puede editarlo? Su autor: misma cuenta (o misma conexión si lo avisó sin cuenta) o la clave que recibió al crearlo
  const esAutor = (f, quien, clave) => f.quien === quien || Boolean(clave && f.clave && sha(clave) === f.clave);
  // Peso de un voto según quién lo da: anónimo 0,5; cuenta normal 1; fiable 2
  const pesoDe = (quien) => {
    if (!quien.startsWith('u:') || !reputacion) return quien.startsWith('u:') ? 1 : 0.5;
    const r = reputacion.de(quien.slice(2));
    return r.nivel === 'fiable' ? 2 : r.nivel === 'baja' ? 0.5 : 1;
  };

  function votar(id, quien, sigue) {
    const i = db.uno('SELECT * FROM incidentes WHERE id = ? AND expira > ?', id, Date.now());
    if (!i) return fallo(404, 'Ese aviso ya no está activo.');
    if (i.quien === quien) return { ok: true, incidente: publico(i, quien) };
    const previo = db.uno('SELECT sigue FROM incidentes_votos WHERE incidente = ? AND quien = ?', id, quien);
    if (previo && Boolean(previo.sigue) === Boolean(sigue)) return { ok: true, incidente: publico(i, quien) };
    db.transaccion(() => {
      db.ejecutar(
        `INSERT INTO incidentes_votos (incidente, quien, sigue, fecha) VALUES (?, ?, ?, ?)
         ON CONFLICT(incidente, quien) DO UPDATE SET sigue = excluded.sigue, fecha = excluded.fecha`,
        id, quien, sigue ? 1 : 0, Date.now()
      );
      const votos = db.todos('SELECT quien, sigue FROM incidentes_votos WHERE incidente = ?', id);
      const c = { si: votos.filter((v) => v.sigue).length, no: votos.filter((v) => !v.sigue).length };
      // Confirmado: dura otro periodo completo desde ahora (con un máximo de 24 h desde que se avisó)
      const expira = sigue ? Math.min(i.creado + MAX_VIDA, Math.max(i.expira, Date.now() + TIPOS[i.tipo].dura)) : i.expira;
      if (c.no >= NEGACIONES_BORRAR) db.ejecutar('UPDATE incidentes SET expira = ?, confirmaciones = ?, negaciones = ? WHERE id = ?', Date.now(), c.si, c.no, id);
      else db.ejecutar('UPDATE incidentes SET expira = ?, confirmaciones = ?, negaciones = ? WHERE id = ?', expira, c.si, c.no, id);
    });
    const f = db.uno('SELECT * FROM incidentes WHERE id = ?', id);
    return { ok: true, incidente: f.expira > Date.now() ? publico(f, quien) : null, quitado: f.expira <= Date.now() };
  }

  return {
    TIPOS,
    // Los activos dentro de un rectángulo (s, w, n, e)
    // mias: claves de los avisos que este dispositivo creó (para marcar cuáles puede editar)
    enZona({ s, w, n, e }, { ip, usuario, claves = [] } = {}) {
      const quien = quienDe({ ip, usuario });
      const hashes = new Set(claves.slice(0, 50).map(sha));
      return db
        .todos('SELECT * FROM incidentes WHERE expira > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY creado DESC LIMIT 300', Date.now(), s, n, w, e)
        .map((f) => ({ ...publico(f, quien), mio: f.quien === quien || hashes.has(f.clave) }));
    },

    // Su autor cambia el tipo (o lo recoloca un poco)
    editar(id, body, { ip, usuario }) {
      const f = db.uno('SELECT * FROM incidentes WHERE id = ? AND expira > ?', String(id), Date.now());
      if (!f) return fallo(404, 'Ese aviso ya no está activo.');
      const quien = quienDe({ ip, usuario });
      if (!esAutor(f, quien, body.clave)) return fallo(403, 'Solo quien avisó puede cambiarlo.');
      const tipo = body.tipo ? String(body.tipo) : f.tipo;
      if (!TIPOS[tipo]) return fallo(400, 'Elige qué tipo de incidente es.');
      let { lat, lng } = f;
      if (body.lat != null && body.lng != null) {
        const nl = Number(body.lat), ng = Number(body.lng);
        if (!Number.isFinite(nl) || !Number.isFinite(ng) || distM(f, { lat: nl, lng: ng }) > 500) return fallo(400, 'Solo puedes moverlo unos metros.');
        lat = Math.round(nl * 1e5) / 1e5;
        lng = Math.round(ng * 1e5) / 1e5;
      }
      // Si cambia de tipo, dura lo que dura el nuevo tipo desde ahora (sin pasar de 24 h)
      const expira = tipo !== f.tipo ? Math.min(f.creado + MAX_VIDA, Date.now() + TIPOS[tipo].dura) : f.expira;
      db.ejecutar('UPDATE incidentes SET tipo = ?, lat = ?, lng = ?, expira = ? WHERE id = ?', tipo, lat, lng, expira, f.id);
      return { ok: true, incidente: publico(db.uno('SELECT * FROM incidentes WHERE id = ?', f.id), quien, body.clave) };
    },

    // Su autor lo quita (ya no está, o se equivocó). No suma puntos.
    quitar(id, body, { ip, usuario }) {
      const f = db.uno('SELECT * FROM incidentes WHERE id = ?', String(id));
      if (!f || f.expira <= Date.now()) return { ok: true };
      if (!esAutor(f, quienDe({ ip, usuario }), body.clave)) return fallo(403, 'Solo quien avisó puede quitarlo.');
      db.ejecutar('UPDATE incidentes SET expira = ?, retirado = 1 WHERE id = ?', Date.now(), f.id);
      return { ok: true };
    },

    crear(body, { ip, usuario }) {
      const tipo = String(body.tipo || '');
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!TIPOS[tipo]) return fallo(400, 'Elige qué tipo de incidente es.');
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 27 || lat > 44.5 || lng < -19 || lng > 5) return fallo(400, 'La posición no es válida (solo España).');
      const quien = quienDe({ ip, usuario });
      const ahora = Date.now();
      const ultimo = db.uno('SELECT creado FROM incidentes WHERE quien = ? ORDER BY creado DESC LIMIT 1', quien);
      if (ultimo && ahora - ultimo.creado < 2 * MIN) return fallo(429, 'Espera un par de minutos antes de enviar otro aviso.');
      if (db.uno('SELECT COUNT(*) AS n FROM incidentes WHERE quien = ? AND creado > ?', quien, ahora - 24 * 60 * MIN).n >= 30) return fallo(429, 'Has enviado muchos avisos hoy. Gracias por ayudar; vuelve a intentarlo mañana.');
      // ¿Ya hay uno igual muy cerca? Entonces cuenta como confirmación
      const d = 0.004;
      const cerca = db
        .todos('SELECT * FROM incidentes WHERE tipo = ? AND expira > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?', tipo, ahora, lat - d, lat + d, lng - d * 1.4, lng + d * 1.4)
        .find((f) => distM(f, { lat, lng }) < 300);
      if (cerca) {
        const r = votar(cerca.id, quien, true);
        return { ...r, existente: true };
      }
      const rumbo = Number.isFinite(Number(body.rumbo)) ? Math.round(Number(body.rumbo)) : null;
      const id = nuevoId();
      const clave = crypto.randomBytes(18).toString('base64url');
      const dura = TIPOS[tipo].dura * (pesoDe(quien) < 1 ? 0.5 : 1);
      db.ejecutar(
        'INSERT INTO incidentes (id, tipo, lat, lng, rumbo, creado, expira, quien, usuario, clave) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, tipo, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, rumbo, ahora, ahora + dura, quien, usuario?.id || null, sha(clave)
      );
      return { ok: true, clave, incidente: publico(db.uno('SELECT * FROM incidentes WHERE id = ?', id), quien) };
    },

    votar(id, sigue, { ip, usuario }) {
      return votar(String(id), quienDe({ ip, usuario }), Boolean(sigue));
    },

    // Mantenimiento: borra los caducados hace más de un día
    limpiar() {
      const limite = Date.now() - 24 * 60 * MIN;
      if (db.uno('SELECT 1 AS si FROM incidentes WHERE expira < ? LIMIT 1', limite)) db.ejecutar('DELETE FROM incidentes WHERE expira < ?', limite);
    },
  };
}
