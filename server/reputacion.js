// Reputación (fiabilidad) de cada usuario: cuánto pesa su opinión en la nota, las alertas y las correcciones de precio.
// Sube con el correo confirmado, la antigüedad, las reseñas con ticket y las correcciones de precio acertadas.
// Baja con el contenido retirado por la moderación o por denuncias.

const DIA = 24 * 3600 * 1000;
export const PESO_ANONIMO = 0.5; // una reseña sin cuenta cuenta la mitad
export const BONUS_TICKET = 1.5; // una reseña con ticket comprobado cuenta un 50 % más
const MIN = 0.2;
const MAX = 2;

export function crearReputacion(db) {
  const cache = new Map(); // usuario -> { t, datos }

  function calcular(usuarioId) {
    const u = db.uno('SELECT verificado, creado, rol FROM usuarios WHERE id = ?', usuarioId);
    if (!u) return { peso: PESO_ANONIMO, nivel: 'anonimo', detalle: {} };
    const edadDias = (Date.now() - u.creado) / DIA;
    const tickets = db.uno('SELECT COUNT(*) AS n FROM reportes WHERE usuario = ? AND ticket = 1 AND oculto = 0', usuarioId).n;
    const retiradas = db.uno(`SELECT COUNT(*) AS n FROM reportes WHERE usuario = ? AND oculto = 1 AND (moderado IS NULL OR moderado != 'aprobado')`, usuarioId).n;
    const aciertos = db.uno(`SELECT COUNT(*) AS n FROM reputacion_eventos WHERE usuario = ? AND tipo = 'correccion_acertada'`, usuarioId).n;
    const fallos = db.uno(`SELECT COUNT(*) AS n FROM reputacion_eventos WHERE usuario = ? AND tipo = 'correccion_fallida'`, usuarioId).n;

    let peso = u.verificado ? 1 : 0.6;
    if (edadDias > 180) peso += 0.2;
    else if (edadDias > 30) peso += 0.1;
    peso += Math.min(0.3, tickets * 0.05);
    peso += Math.min(0.3, aciertos * 0.05);
    peso -= Math.min(0.6, fallos * 0.1);
    peso -= retiradas * 0.3;
    peso = Math.round(Math.min(MAX, Math.max(MIN, peso)) * 100) / 100;
    const nivel = peso >= 1.25 ? 'fiable' : peso < 0.6 ? 'baja' : 'normal';
    return { peso, nivel, detalle: { verificado: Boolean(u.verificado), antiguedadDias: Math.floor(edadDias), tickets, aciertos, fallos, retiradas } };
  }

  return {
    // { peso, nivel: 'anonimo' | 'baja' | 'normal' | 'fiable', detalle }
    de(usuarioId) {
      if (!usuarioId) return { peso: PESO_ANONIMO, nivel: 'anonimo', detalle: {} };
      const c = cache.get(usuarioId);
      if (c && Date.now() - c.t < 10 * 60 * 1000) return c.datos;
      const datos = calcular(usuarioId);
      cache.set(usuarioId, { t: Date.now(), datos });
      return datos;
    },
    peso(usuarioId) {
      return this.de(usuarioId).peso;
    },
    // Peso de una reseña concreta
    pesoReseña(usuarioId, conTicket) {
      return Math.round(this.peso(usuarioId) * (conTicket ? BONUS_TICKET : 1) * 100) / 100;
    },
    anotar(usuarioId, tipo, ref) {
      if (!usuarioId) return;
      db.ejecutar('INSERT OR IGNORE INTO reputacion_eventos (usuario, tipo, ref, fecha) VALUES (?, ?, ?, ?)', usuarioId, tipo, ref, Date.now());
      cache.delete(usuarioId);
    },
    olvidar: (usuarioId) => cache.delete(usuarioId),
  };
}
