// Valoraciones de calidad del combustible: alertas, denuncias, respuestas y moderación (SQLite).

import crypto from 'node:crypto';

export const PROBLEMAS = {
  tirones: 'El motor da tirones o falla',
  consumo: 'Más consumo / menos autonomía',
  arranque: 'Problemas de arranque',
  agua: 'Sospecha de agua o suciedad',
  testigo: 'Se encendió un testigo de avería',
  medida: 'El surtidor no sirve lo que marca',
  olor: 'Olor o color extraño',
  precio_declarado: 'El precio no era el que anuncia la gasolinera',
};

const DIA = 24 * 3600 * 1000;
const VENTANA_MS = 365 * DIA; // solo cuentan los últimos 12 meses
const ANTISPAM_MS = DIA; // 1 valoración por gasolinera y persona al día
const MAX_DIARIOS = 10; // máximo de valoraciones por persona al día en total
const ALERTA_MS = 7 * DIA; // ventana para detectar problemas recientes
const ALERTA_MIN = 3; // peso que deben sumar las personas distintas que coinciden (3 usuarios normales)
const DENUNCIAS_OCULTAR = 3; // denuncias que ocultan una valoración hasta que la revise un moderador
const PRIOR_MEDIA = 3; // suavizado bayesiano: pocas opiniones no disparan la nota
const PRIOR_PESO = 3;
const SAL = process.env.REPORT_SALT || 'gasomapa-cambia-esto';

export const huella = (ip) => crypto.createHash('sha256').update(SAL + ip).digest('hex').slice(0, 16);

const COLUMNAS = `r.*, (SELECT COUNT(*) FROM denuncias d WHERE d.reporte = r.id) AS n_denuncias`;

// Fila de la base de datos → objeto de la API
function aObjeto(f) {
  return {
    id: f.id,
    estacion: f.estacion,
    puntuacion: f.puntuacion,
    problemas: JSON.parse(f.problemas || '[]'),
    combustible: f.combustible,
    comentario: f.comentario,
    fecha: f.fecha,
    quien: f.quien,
    usuario: f.usuario,
    ...(f.autor ? { autor: f.autor, autorVerificado: Boolean(f.autor_verificado) } : {}),
    ...(f.oculto ? { oculto: true } : {}),
    ...(f.moderado ? { moderado: f.moderado } : {}),
    ...(f.editado ? { editado: f.editado } : {}),
    ...(f.ticket ? { ticket: true } : {}),
    ...(f.resp_texto ? { respuesta: { texto: f.resp_texto, empresa: f.resp_empresa, fecha: f.resp_fecha } } : {}),
    denuncias: f.n_denuncias ?? 0,
  };
}

export function crearAlmacenReportes(db, reputacion) {
  const pesoDe = (r) => (reputacion ? reputacion.pesoReseña(r.usuario, r.ticket) : 1);
  // La nota de todas las gasolineras se calcula a menudo: se guarda 30 s o hasta el próximo cambio
  let cacheGlobal = null;
  const invalidar = () => (cacheGlobal = null);

  // Alerta: personas distintas que reportan lo mismo en 7 días, sumando su fiabilidad
  // (3 usuarios normales, o menos si son fiables y han aportado ticket; harían falta 6 anónimos)
  const alertaDe = (reps) => {
    const desde = Date.now() - ALERTA_MS;
    const recientes = reps.filter((r) => r.fecha >= desde);
    if (recientes.length < 2) return null;
    const porProblema = {};
    const malas = new Map();
    const sumar = (m, quien, w) => m.set(quien, Math.max(m.get(quien) || 0, w));
    for (const r of recientes) {
      const w = pesoDe(r);
      for (const p of r.problemas) sumar((porProblema[p] ||= new Map()), r.quien, w);
      if (r.puntuacion <= 2) sumar(malas, r.quien, w);
    }
    const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    let mejor = null;
    for (const [p, m] of Object.entries(porProblema)) {
      const w = total(m);
      if (w >= ALERTA_MIN - 1e-9 && m.size >= 2 && (!mejor || w > mejor.peso)) mejor = { problema: p, texto: PROBLEMAS[p], n: m.size, peso: +w.toFixed(2) };
    }
    if (mejor) return mejor;
    const wm = total(malas);
    if (wm >= ALERTA_MIN - 1e-9 && malas.size >= 2) return { problema: 'notas', texto: 'Varias valoraciones muy bajas', n: malas.size, peso: +wm.toFixed(2) };
    return null;
  };

  const resumir = (reps) => {
    const total = reps.length;
    if (!total) return { total: 0, media: null, puntuacion: null, problemas: {}, alerta: null };
    // Media ponderada por la fiabilidad de cada persona (y el ticket), con suavizado bayesiano
    let suma = 0, pesos = 0;
    for (const r of reps) {
      const w = pesoDe(r);
      suma += w * r.puntuacion;
      pesos += w;
    }
    const problemas = {};
    for (const r of reps) for (const p of r.problemas) problemas[p] = (problemas[p] || 0) + 1;
    return {
      total,
      conTicket: reps.filter((r) => r.ticket).length,
      media: +(suma / pesos).toFixed(2),
      puntuacion: +(((suma + PRIOR_MEDIA * PRIOR_PESO) / (pesos + PRIOR_PESO)) * 2).toFixed(1), // nota 0–10
      problemas,
      alerta: alertaDe(reps),
    };
  };

  // Comprueba los datos de una valoración (al crearla o al editarla)
  function validar(body) {
    const puntuacion = Number(body.puntuacion);
    if (!Number.isInteger(puntuacion) || puntuacion < 1 || puntuacion > 5) return { error: 'Elige una valoración de 1 a 5.' };
    return {
      puntuacion,
      problemas: Array.isArray(body.problemas) ? [...new Set(body.problemas.filter((p) => typeof p === 'string' && p in PROBLEMAS))] : [],
      combustible: typeof body.combustible === 'string' ? body.combustible.slice(0, 30) : '',
      comentario: typeof body.comentario === 'string' ? body.comentario.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
    };
  }

  // ¿Es de esta persona? Con cuenta: por la cuenta. Sin cuenta: por la huella de su conexión.
  function esSuya(f, identidad, usuarioId) {
    if (f.usuario) return f.usuario === usuarioId;
    return f.quien === huella(identidad);
  }

  // Lo que ve cualquiera: sin huellas ni ids internos
  const publico = ({ quien, usuario, ...r }, yo) => ({
    ...r,
    mio: yo ? quien === yo : undefined,
    ...(usuario && reputacion && reputacion.de(usuario).nivel === 'fiable' ? { fiable: true } : {}),
  });

  const vigentesDe = (estacion) =>
    db.todos(`SELECT ${COLUMNAS} FROM reportes r WHERE estacion = ? AND fecha >= ? AND oculto = 0 ORDER BY fecha DESC`, estacion, Date.now() - VENTANA_MS).map(aObjeto);

  return {
    resumenGlobal() {
      if (cacheGlobal && Date.now() - cacheGlobal.t < 30_000) return cacheGlobal.datos;
      const porEstacion = new Map();
      const filas = db.todos('SELECT estacion, puntuacion, problemas, fecha, quien, usuario, ticket FROM reportes WHERE fecha >= ? AND oculto = 0', Date.now() - VENTANA_MS);
      for (const f of filas) {
        const r = { ...f, problemas: JSON.parse(f.problemas) };
        if (!porEstacion.has(r.estacion)) porEstacion.set(r.estacion, []);
        porEstacion.get(r.estacion).push(r);
      }
      const out = {};
      for (const [id, reps] of porEstacion) {
        const s = resumir(reps);
        out[id] = { total: s.total, puntuacion: s.puntuacion, ...(s.alerta ? { alerta: s.alerta } : {}) };
      }
      cacheGlobal = { t: Date.now(), datos: out };
      return out;
    },

    // identidad: 'u:<id>' si hay sesión, o la IP
    deEstacion(id, identidad) {
      const yo = identidad ? huella(identidad) : null;
      const reps = vigentesDe(id);
      return { resumen: resumir(reps), reportes: reps.slice(0, 30).map((r) => publico(r, yo)) };
    },

    // autor: { id, alias, verificado } si la persona ha iniciado sesión
    // ticket: datos ya validados de un ticket ({ hash, fecha, litros, importe }) o null
    crear(estacion, body, identidad, autor = null, ticket = null) {
      const v = validar(body);
      if (v.error) return v;
      const { puntuacion, problemas, combustible, comentario } = v;
      const quien = huella(identidad);
      const ahora = Date.now();

      return db.transaccion(() => {
        const c = db.uno('SELECT COUNT(*) AS n, SUM(estacion = ?) AS aqui FROM reportes WHERE quien = ? AND fecha > ?', estacion, quien, ahora - ANTISPAM_MS);
        if (c.aqui > 0) return { status: 429, error: 'Ya has valorado esta gasolinera hoy. Puedes volver a hacerlo mañana.' };
        if (c.n >= MAX_DIARIOS) return { status: 429, error: `Has llegado al máximo de ${MAX_DIARIOS} valoraciones por día.` };
        if (ticket && db.uno('SELECT 1 AS si FROM tickets WHERE hash = ?', ticket.hash)) {
          return { status: 409, error: 'Ese ticket ya se ha usado en otra valoración.' };
        }
        const id = crypto.randomUUID();
        db.ejecutar(
          `INSERT INTO reportes (id, estacion, puntuacion, problemas, combustible, comentario, fecha, quien, usuario, autor, autor_verificado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, estacion, puntuacion, JSON.stringify(problemas), combustible, comentario, ahora, quien,
          autor?.id ?? null, autor?.alias ?? null, Boolean(autor?.verificado)
        );
        if (ticket) {
          db.ejecutar('UPDATE reportes SET ticket = 1 WHERE id = ?', id);
          db.ejecutar('INSERT INTO tickets (hash, reporte, usuario, estacion, fecha, litros, importe, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ticket.hash, id, autor?.id ?? null, estacion, ticket.fecha, ticket.litros, ticket.importe, Date.now());
          reputacion?.olvidar(autor?.id);
        }
        invalidar();
        const nuevo = aObjeto(db.uno(`SELECT ${COLUMNAS} FROM reportes r WHERE id = ?`, id));
        return { reporte: publico(nuevo, quien), resumen: resumir(vigentesDe(estacion)) };
      });
    },

    editar(id, body, identidad, usuarioId) {
      const f = db.uno('SELECT * FROM reportes WHERE id = ?', id);
      if (!f || f.oculto) return { status: 404, error: 'Esa valoración ya no está disponible.' };
      if (!esSuya(f, identidad, usuarioId)) return { status: 403, error: 'Solo puedes editar tus propias valoraciones.' };
      const v = validar(body);
      if (v.error) return v;
      db.ejecutar('UPDATE reportes SET puntuacion = ?, problemas = ?, combustible = ?, comentario = ?, editado = ? WHERE id = ?',
        v.puntuacion, JSON.stringify(v.problemas), v.combustible, v.comentario, Date.now(), id);
      invalidar();
      const nuevo = aObjeto(db.uno(`SELECT ${COLUMNAS} FROM reportes r WHERE id = ?`, id));
      return { reporte: publico(nuevo, f.quien), resumen: resumir(vigentesDe(f.estacion)) };
    },

    eliminar(id, identidad, usuarioId) {
      const f = db.uno('SELECT * FROM reportes WHERE id = ?', id);
      if (!f) return { status: 404, error: 'Esa valoración ya no existe.' };
      if (!esSuya(f, identidad, usuarioId)) return { status: 403, error: 'Solo puedes eliminar tus propias valoraciones.' };
      db.ejecutar('DELETE FROM reportes WHERE id = ?', id); // sus denuncias se borran en cascada
      invalidar();
      return { ok: true, estacion: f.estacion, resumen: resumir(vigentesDe(f.estacion)) };
    },

    // Las valoraciones de una cuenta, para "Mis valoraciones"
    deUsuario(usuarioId) {
      return db.todos(`SELECT ${COLUMNAS} FROM reportes r WHERE usuario = ? ORDER BY fecha DESC LIMIT 200`, usuarioId).map((f) => {
        const { quien, usuario, ...r } = aObjeto(f);
        return r;
      });
    },

    denunciar(id, identidad) {
      return db.transaccion(() => {
        const r = db.uno('SELECT id, quien, oculto, moderado FROM reportes WHERE id = ?', id);
        if (!r || r.oculto) return { status: 404, error: 'Esa valoración ya no está disponible.' };
        const quien = huella(identidad);
        if (r.quien === quien) return { status: 400, error: 'No puedes denunciar tu propia valoración.' };
        const res = db.ejecutar('INSERT OR IGNORE INTO denuncias (reporte, quien, fecha) VALUES (?, ?, ?)', id, quien, Date.now());
        if (!res.changes) return { ok: true, yaDenunciado: true };
        const n = db.uno('SELECT COUNT(*) AS n FROM denuncias WHERE reporte = ?', id).n;
        let oculto = false;
        if (n >= DENUNCIAS_OCULTAR && r.moderado !== 'aprobado') {
          db.ejecutar('UPDATE reportes SET oculto = 1 WHERE id = ?', id);
          reputacion?.olvidar(db.uno('SELECT usuario FROM reportes WHERE id = ?', id)?.usuario);
          oculto = true;
          invalidar();
        }
        return { ok: true, oculto };
      });
    },

    // Respuesta pública de la gasolinera (solo su dueño verificado). Texto vacío = borrar respuesta.
    responder(id, texto, empresa, esDueno) {
      const r = db.uno('SELECT estacion, oculto FROM reportes WHERE id = ?', id);
      if (!r || r.oculto) return { status: 404, error: 'Esa valoración ya no está disponible.' };
      if (!esDueno(r.estacion)) return { status: 403, error: 'Solo la gasolinera valorada puede responder.' };
      const t = typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
      if (!t) {
        db.ejecutar('UPDATE reportes SET resp_texto = NULL, resp_empresa = NULL, resp_fecha = NULL WHERE id = ?', id);
        return { ok: true, respuesta: null };
      }
      const fecha = Date.now();
      db.ejecutar('UPDATE reportes SET resp_texto = ?, resp_empresa = ?, resp_fecha = ? WHERE id = ?', t, empresa, fecha, id);
      return { ok: true, respuesta: { texto: t, empresa, fecha } };
    },

    // Borrado de cuenta: las valoraciones se quedan, pero anónimas
    anonimizarUsuario(usuarioId) {
      const r = db.ejecutar('UPDATE reportes SET usuario = NULL, autor = NULL, autor_verificado = 0 WHERE usuario = ?', usuarioId);
      return r.changes;
    },

    // --- Moderación (ADMIN_TOKEN) ---
    listarAdmin(filtro = 'denunciados') {
      const where =
        filtro === 'ocultos' ? 'r.oculto = 1'
        : filtro === 'todos' ? '1 = 1'
        : `EXISTS (SELECT 1 FROM denuncias d WHERE d.reporte = r.id) AND (r.moderado IS NULL OR r.moderado != 'aprobado')`;
      return db
        .todos(`SELECT ${COLUMNAS} FROM reportes r WHERE ${where} ORDER BY n_denuncias DESC, fecha DESC LIMIT 200`)
        .map(aObjeto)
        .map(({ usuario, ...r }) => r);
    },

    moderar(id, accion) {
      const existe = db.uno('SELECT id FROM reportes WHERE id = ?', id);
      if (!existe) return { status: 404, error: 'No existe.' };
      if (accion === 'ocultar') db.ejecutar(`UPDATE reportes SET oculto = 1, moderado = 'oculto' WHERE id = ?`, id);
      else if (accion === 'aprobar') db.ejecutar(`UPDATE reportes SET oculto = 0, moderado = 'aprobado' WHERE id = ?`, id);
      else if (accion === 'borrar') db.ejecutar('DELETE FROM reportes WHERE id = ?', id);
      else return { status: 400, error: 'Acción no válida (ocultar, aprobar o borrar).' };
      invalidar();
      reputacion?.olvidar(db.uno('SELECT usuario FROM reportes WHERE id = ?', id)?.usuario);
      return { ok: true };
    },
  };
}
