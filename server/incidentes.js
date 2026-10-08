// Incidentes de tráfico avisados por los conductores desde el GPS (como Waze):
// accidentes, atascos, controles, obras, peligros en la vía…
// - Cada aviso caduca solo (según el tipo) y se alarga cuando otros conductores confirman que sigue ahí.
// - Si varios dicen que ya no está, desaparece.
// - Límites para evitar abusos: un aviso cada 2 minutos y 30 al día por persona; no se repite el mismo
//   incidente si ya hay uno igual a menos de 300 m (en ese caso cuenta como confirmación).

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
const NEGACIONES_BORRAR = 2;
const fallo = (status, error) => ({ status, error });

const distM = (a, b) => {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111320;
};

export function crearIncidentes(db) {
  const nuevoId = () => crypto.randomBytes(9).toString('base64url');
  const publico = (f) => ({ id: f.id, tipo: f.tipo, nombre: TIPOS[f.tipo]?.nombre || f.tipo, lat: f.lat, lng: f.lng, rumbo: f.rumbo, creado: f.creado, expira: f.expira, confirmaciones: f.confirmaciones });

  function votar(id, quien, sigue) {
    const i = db.uno('SELECT * FROM incidentes WHERE id = ? AND expira > ?', id, Date.now());
    if (!i) return fallo(404, 'Ese aviso ya no está activo.');
    if (i.quien === quien) return { ok: true, incidente: publico(i) };
    const previo = db.uno('SELECT sigue FROM incidentes_votos WHERE incidente = ? AND quien = ?', id, quien);
    if (previo && Boolean(previo.sigue) === Boolean(sigue)) return { ok: true, incidente: publico(i) };
    db.transaccion(() => {
      db.ejecutar(
        `INSERT INTO incidentes_votos (incidente, quien, sigue, fecha) VALUES (?, ?, ?, ?)
         ON CONFLICT(incidente, quien) DO UPDATE SET sigue = excluded.sigue, fecha = excluded.fecha`,
        id, quien, sigue ? 1 : 0, Date.now()
      );
      const c = db.uno('SELECT COALESCE(SUM(sigue), 0) AS si, COUNT(*) - COALESCE(SUM(sigue), 0) AS no FROM incidentes_votos WHERE incidente = ?', id);
      // Confirmado: dura otro periodo completo desde ahora (con un máximo de 24 h desde que se avisó)
      const expira = sigue ? Math.min(i.creado + MAX_VIDA, Math.max(i.expira, Date.now() + TIPOS[i.tipo].dura)) : i.expira;
      if (c.no >= NEGACIONES_BORRAR && c.no > c.si) db.ejecutar('UPDATE incidentes SET expira = ?, confirmaciones = ?, negaciones = ? WHERE id = ?', Date.now(), c.si, c.no, id);
      else db.ejecutar('UPDATE incidentes SET expira = ?, confirmaciones = ?, negaciones = ? WHERE id = ?', expira, c.si, c.no, id);
    });
    const f = db.uno('SELECT * FROM incidentes WHERE id = ?', id);
    return { ok: true, incidente: f.expira > Date.now() ? publico(f) : null };
  }

  return {
    TIPOS,
    // Los activos dentro de un rectángulo (s, w, n, e)
    enZona({ s, w, n, e }) {
      return db
        .todos('SELECT * FROM incidentes WHERE expira > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY creado DESC LIMIT 300', Date.now(), s, n, w, e)
        .map(publico);
    },

    crear(body, { ip, usuario }) {
      const tipo = String(body.tipo || '');
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!TIPOS[tipo]) return fallo(400, 'Elige qué tipo de incidente es.');
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 27 || lat > 44.5 || lng < -19 || lng > 5) return fallo(400, 'La posición no es válida (solo España).');
      const quien = usuario ? 'u:' + usuario.id : 'ip:' + huella(ip);
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
      db.ejecutar(
        'INSERT INTO incidentes (id, tipo, lat, lng, rumbo, creado, expira, quien, usuario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, tipo, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, rumbo, ahora, ahora + TIPOS[tipo].dura, quien, usuario?.id || null
      );
      return { ok: true, incidente: publico(db.uno('SELECT * FROM incidentes WHERE id = ?', id)) };
    },

    votar(id, sigue, { ip, usuario }) {
      return votar(String(id), usuario ? 'u:' + usuario.id : 'ip:' + huella(ip), Boolean(sigue));
    },

    // Mantenimiento: borra los caducados hace más de un día
    limpiar() {
      const limite = Date.now() - 24 * 60 * MIN;
      if (db.uno('SELECT 1 AS si FROM incidentes WHERE expira < ? LIMIT 1', limite)) db.ejecutar('DELETE FROM incidentes WHERE expira < ?', limite);
    },
  };
}
