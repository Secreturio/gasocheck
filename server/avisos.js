// Avisos: alertas de precio, alertas de calidad en tus favoritas y mensajes de gasolineras Pro a sus seguidores.
// Cada aviso se guarda en la bandeja del usuario (la ve en la app) y, si lo permitió, llega como notificación push.

import crypto from 'node:crypto';

const DIA = 24 * 3600 * 1000;
const COMBUSTIBLES = ['gasoleoA', 'gasoleoPremium', 'gasolina95', 'gasolina98', 'glp'];
const NOMBRES = { gasoleoA: 'Gasóleo A', gasoleoPremium: 'Gasóleo Premium', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', glp: 'Autogás' };
const MAX_ALERTAS = 30;
const PAUSA_MENSAJES_MS = 7 * DIA; // una gasolinera Pro puede escribir a sus seguidores una vez por semana
const eur = (n) => n.toFixed(3).replace('.', ',');
const fallo = (status, error) => ({ status, error });

export function crearAvisos(db, { push, reportes, proveedores }) {
  const nuevoId = () => crypto.randomBytes(9).toString('base64url');

  // Guarda el aviso y lo envía a todos los dispositivos suscritos de esa persona
  async function notificar(usuario, { tipo, titulo, texto, estacion = null }) {
    db.ejecutar('INSERT INTO avisos (id, usuario, tipo, titulo, texto, estacion, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)', nuevoId(), usuario, tipo, titulo, texto, estacion, Date.now());
    // La bandeja guarda los últimos 100
    db.ejecutar('DELETE FROM avisos WHERE usuario = ? AND id NOT IN (SELECT id FROM avisos WHERE usuario = ? ORDER BY fecha DESC LIMIT 100)', usuario, usuario);
    if (!push) return;
    const subs = db.todos('SELECT endpoint, p256dh, auth FROM suscripciones_push WHERE usuario = ?', usuario);
    await Promise.all(
      subs.map(async (s) => {
        try {
          const r = await push.enviar(s, { titulo, texto, url: estacion ? `./#e${estacion}` : './', tipo });
          if (r === 'caducada') db.ejecutar('DELETE FROM suscripciones_push WHERE endpoint = ?', s.endpoint);
        } catch (e) {
          console.warn('Notificación no enviada:', e.message);
        }
      })
    );
  }

  // Favoritas de cada usuario, desde sus datos sincronizados
  function favoritasDeTodos() {
    const out = [];
    for (const f of db.todos('SELECT usuario, datos FROM sync')) {
      try {
        const favs = JSON.parse(f.datos).favoritas || [];
        if (favs.length) out.push({ usuario: f.usuario, favoritas: favs });
      } catch {
        /* datos dañados: se ignoran */
      }
    }
    return out;
  }

  return {
    notificar,

    // ---- Alertas de precio ----
    crearAlerta(u, body, existe) {
      const estacion = String(body.estacion || '');
      const combustible = String(body.combustible || '');
      const umbral = Math.round(Number(String(body.umbral ?? '').replace(',', '.')) * 1000) / 1000;
      if (!existe(estacion)) return fallo(404, 'Esa gasolinera no está en el listado oficial.');
      if (!COMBUSTIBLES.includes(combustible)) return fallo(400, 'Elige un combustible.');
      if (!Number.isFinite(umbral) || umbral < 0.3 || umbral > 4) return fallo(400, 'Escribe el precio por litro, por ejemplo 1,399.');
      const n = db.uno('SELECT COUNT(*) AS n FROM alertas_precio WHERE usuario = ?', u.id).n;
      const existente = db.uno('SELECT id FROM alertas_precio WHERE usuario = ? AND estacion = ? AND combustible = ?', u.id, estacion, combustible);
      if (!existente && n >= MAX_ALERTAS) return fallo(429, `Puedes tener como mucho ${MAX_ALERTAS} alertas de precio.`);
      // Si ya existía, se actualiza el umbral y se vuelve a vigilar desde cero
      db.ejecutar(
        `INSERT INTO alertas_precio (id, usuario, estacion, combustible, umbral, creada) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(usuario, estacion, combustible) DO UPDATE SET umbral = excluded.umbral, ultimo_precio = NULL, ultimo_aviso = NULL`,
        nuevoId(), u.id, estacion, combustible, umbral, Date.now()
      );
      return { alerta: db.uno('SELECT * FROM alertas_precio WHERE usuario = ? AND estacion = ? AND combustible = ?', u.id, estacion, combustible) };
    },
    alertasDe: (u) => db.todos('SELECT id, estacion, combustible, umbral, creada, ultimo_aviso, ultimo_precio FROM alertas_precio WHERE usuario = ? ORDER BY creada DESC', u.id),
    borrarAlerta(u, id) {
      const r = db.ejecutar('DELETE FROM alertas_precio WHERE id = ? AND usuario = ?', id, u.id);
      return r.changes ? { ok: true } : fallo(404, 'No existe esa alerta.');
    },

    // ---- Bandeja ----
    bandeja(u) {
      return {
        avisos: db.todos('SELECT id, tipo, titulo, texto, estacion, fecha, leido FROM avisos WHERE usuario = ? ORDER BY fecha DESC LIMIT 50', u.id).map((a) => ({ ...a, leido: Boolean(a.leido) })),
        sinLeer: db.uno('SELECT COUNT(*) AS n FROM avisos WHERE usuario = ? AND leido = 0', u.id).n,
      };
    },
    marcarLeidos(u) {
      db.ejecutar('UPDATE avisos SET leido = 1 WHERE usuario = ?', u.id);
      return { ok: true };
    },

    // ---- Suscripciones push ----
    suscribir(u, body) {
      const endpoint = String(body.endpoint || '');
      const p256dh = String(body.keys?.p256dh || '');
      const auth = String(body.keys?.auth || '');
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        return fallo(400, 'Suscripción no válida.');
      }
      if (url.protocol !== 'https:' || !p256dh || !auth || endpoint.length > 1000) return fallo(400, 'Suscripción no válida.');
      db.ejecutar(
        `INSERT INTO suscripciones_push (endpoint, usuario, p256dh, auth, creada) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET usuario = excluded.usuario, p256dh = excluded.p256dh, auth = excluded.auth`,
        endpoint, u.id, p256dh, auth, Date.now()
      );
      return { ok: true };
    },
    desuscribir(u, body) {
      db.ejecutar('DELETE FROM suscripciones_push WHERE endpoint = ? AND usuario = ?', String(body.endpoint || ''), u.id);
      return { ok: true };
    },

    /**
     * Se ejecuta tras cada actualización de precios.
     * precioActual(estacion, combustible) → el oficial, o el del hueco de la gasolinera si el Ministerio no lo tiene.
     */
    async evaluar(precioActual, nombreDe) {
      let enviados = 0;
      // 1) Alertas de precio: avisa cuando el precio cruza por debajo del umbral
      for (const a of db.todos('SELECT * FROM alertas_precio')) {
        const p = precioActual(a.estacion, a.combustible);
        if (p == null) continue;
        const cruza = p <= a.umbral + 1e-9 && (a.ultimo_precio == null || a.ultimo_precio > a.umbral + 1e-9);
        db.ejecutar('UPDATE alertas_precio SET ultimo_precio = ?, ultimo_aviso = CASE WHEN ? THEN ? ELSE ultimo_aviso END WHERE id = ?', p, cruza, Date.now(), a.id);
        if (cruza) {
          await notificar(a.usuario, {
            tipo: 'precio',
            titulo: `${NOMBRES[a.combustible]} a ${eur(p)} €`,
            texto: `${nombreDe(a.estacion)} ya está por debajo de tu aviso de ${eur(a.umbral)} €/l.`,
            estacion: a.estacion,
          });
          enviados++;
        }
      }
      // 2) Alertas de calidad en gasolineras favoritas (una vez por problema y semana)
      const calidad = reportes.resumenGlobal();
      for (const { usuario, favoritas } of favoritasDeTodos()) {
        for (const est of favoritas) {
          const al = calidad[est]?.alerta;
          if (!al) continue;
          const previo = db.uno('SELECT fecha FROM avisos_calidad_enviados WHERE usuario = ? AND estacion = ? AND problema = ?', usuario, est, al.problema);
          if (previo && Date.now() - previo.fecha < 7 * DIA) continue;
          db.ejecutar(
            `INSERT INTO avisos_calidad_enviados (usuario, estacion, problema, fecha) VALUES (?, ?, ?, ?)
             ON CONFLICT(usuario, estacion, problema) DO UPDATE SET fecha = excluded.fecha`,
            usuario, est, al.problema, Date.now()
          );
          await notificar(usuario, {
            tipo: 'calidad',
            titulo: 'Alerta de calidad en una favorita',
            texto: `${nombreDe(est)}: ${al.n} conductores han reportado “${al.texto}” esta semana.`,
            estacion: est,
          });
          enviados++;
        }
      }
      return enviados;
    },

    // ---- GasoCheck Pro: mensaje de la gasolinera a quienes la tienen en favoritas ----
    async mensajeASeguidores(u, estacion, texto, { esPro, nombre }) {
      if (!proveedores.esDueno(u.id, estacion)) return fallo(403, 'Esta gasolinera no está asociada a tu cuenta.');
      if (!esPro) return fallo(402, 'Los mensajes a clientes son una función de GasoCheck Pro.');
      const t = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (t.length < 5) return fallo(400, 'Escribe el mensaje (entre 5 y 160 caracteres).');
      const ultimo = db.uno('SELECT fecha FROM mensajes_seguidores WHERE estacion = ? ORDER BY fecha DESC LIMIT 1', estacion);
      if (ultimo && Date.now() - ultimo.fecha < PAUSA_MENSAJES_MS) {
        const dias = Math.ceil((PAUSA_MENSAJES_MS - (Date.now() - ultimo.fecha)) / DIA);
        return fallo(429, `Solo puedes enviar un mensaje por semana. Podrás enviar otro en ${dias} día${dias === 1 ? '' : 's'}.`);
      }
      const seguidores = favoritasDeTodos().filter((f) => f.favoritas.includes(estacion)).map((f) => f.usuario);
      for (const s of seguidores) await notificar(s, { tipo: 'gasolinera', titulo: nombre, texto: t, estacion });
      db.ejecutar('INSERT INTO mensajes_seguidores (id, estacion, usuario, texto, fecha, enviados) VALUES (?, ?, ?, ?, ?, ?)', nuevoId(), estacion, u.id, t, Date.now(), seguidores.length);
      return { ok: true, enviados: seguidores.length };
    },
    seguidores: (estacion) => favoritasDeTodos().filter((f) => f.favoritas.includes(estacion)).length,
    ultimoMensaje: (estacion) => db.uno('SELECT texto, fecha, enviados FROM mensajes_seguidores WHERE estacion = ? ORDER BY fecha DESC LIMIT 1', estacion),
  };
}
