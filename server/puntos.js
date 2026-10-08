// Puntos, medallas y ranking mensual por provincia.
// Se calculan a partir de lo que cada persona ya aporta (no hay que guardar nada aparte):
//   valoración 10 pts (+10 con ticket comprobado) · corrección de precio 5 · aviso de incidente 5
//   (+2 por cada confirmación que recibe) · confirmar o desmentir un aviso 2
// La provincia de cada persona es la de las gasolineras que más valora o corrige.

const MEDALLAS = [
  { id: 'primera', nombre: 'Primera valoración', icono: '⭐', cumple: (t) => t.valoraciones >= 1 },
  { id: 'critico', nombre: 'Crítico de surtidor', icono: '🏅', cumple: (t) => t.valoraciones >= 10 },
  { id: 'ticket', nombre: 'Ticket en mano', icono: '🧾', cumple: (t) => t.tickets >= 5 },
  { id: 'cazaprecios', nombre: 'Cazaprecios', icono: '💶', cumple: (t) => t.correcciones >= 5 },
  { id: 'vigia', nombre: 'Vigía de la carretera', icono: '🚨', cumple: (t) => t.incidentes >= 10 },
  { id: 'halcon', nombre: 'Ojo de halcón', icono: '🦅', cumple: (t) => t.votos >= 20 },
  { id: 'fiable', nombre: 'Conductor fiable', icono: '🛡️', cumple: (t) => t.fiable },
];

const inicioMes = (d = new Date()) => {
  const [y, m] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).format(d).split('-').map(Number);
  return Date.UTC(y, m - 1, 1) - 2 * 3600 * 1000; // aproximado a la hora de Madrid
};

export function crearPuntos(db, { reputacion }) {
  // Totales por usuario desde una fecha
  function totales(desde = 0) {
    const t = new Map();
    const de = (u) => {
      let x = t.get(u);
      if (!x) t.set(u, (x = { valoraciones: 0, tickets: 0, correcciones: 0, incidentes: 0, confirmacionesRecibidas: 0, votos: 0 }));
      return x;
    };
    for (const f of db.todos('SELECT usuario, COUNT(*) AS n, SUM(ticket) AS tk FROM reportes WHERE usuario IS NOT NULL AND oculto = 0 AND fecha >= ? GROUP BY usuario', desde)) {
      de(f.usuario).valoraciones = f.n;
      de(f.usuario).tickets = f.tk || 0;
    }
    for (const f of db.todos('SELECT usuario, COUNT(*) AS n FROM correcciones_precio WHERE fecha >= ? GROUP BY usuario', desde)) de(f.usuario).correcciones = f.n;
    for (const f of db.todos('SELECT usuario, COUNT(*) AS n, SUM(confirmaciones) AS c FROM incidentes WHERE usuario IS NOT NULL AND creado >= ? GROUP BY usuario', desde)) {
      de(f.usuario).incidentes = f.n;
      de(f.usuario).confirmacionesRecibidas = f.c || 0;
    }
    for (const f of db.todos(`SELECT substr(quien, 3) AS usuario, COUNT(*) AS n FROM incidentes_votos WHERE quien LIKE 'u:%' AND fecha >= ? GROUP BY quien`, desde)) de(f.usuario).votos = f.n;
    return t;
  }
  const puntosDe = (x) => x.valoraciones * 10 + x.tickets * 10 + x.correcciones * 5 + x.incidentes * 5 + x.confirmacionesRecibidas * 2 + x.votos * 2;

  // Provincia de cada usuario (la más repetida en sus valoraciones y correcciones)
  function provincias(provinciaDe) {
    const cuenta = new Map();
    const sumar = (u, est, n) => {
      const p = provinciaDe(est);
      if (!p) return;
      const m = cuenta.get(u) || new Map();
      m.set(p, (m.get(p) || 0) + n);
      cuenta.set(u, m);
    };
    for (const f of db.todos('SELECT usuario, estacion, COUNT(*) AS n FROM reportes WHERE usuario IS NOT NULL GROUP BY usuario, estacion')) sumar(f.usuario, f.estacion, f.n);
    for (const f of db.todos('SELECT usuario, estacion, COUNT(*) AS n FROM correcciones_precio GROUP BY usuario, estacion')) sumar(f.usuario, f.estacion, f.n);
    const out = new Map();
    for (const [u, m] of cuenta) out.set(u, [...m].sort((a, b) => b[1] - a[1])[0][0]);
    return out;
  }

  return {
    MEDALLAS: MEDALLAS.map(({ id, nombre, icono }) => ({ id, nombre, icono })),
    // { mes: [...], provincias: [...], yo }
    ranking({ provincia = '', usuario = null, provinciaDe }) {
      const mes = totales(inicioMes());
      const prov = provincias(provinciaDe);
      const filas = [];
      for (const [u, x] of mes) {
        const pts = puntosDe(x);
        if (!pts) continue;
        if (provincia && prov.get(u) !== provincia) continue;
        filas.push({ u, pts });
      }
      filas.sort((a, b) => b.pts - a.pts);
      const alias = (id) => db.uno('SELECT alias, verificado FROM usuarios WHERE id = ?', id);
      const lista = filas.slice(0, 20).map((f, i) => {
        const a = alias(f.u);
        return { puesto: i + 1, alias: a?.alias || 'Conductor', verificado: Boolean(a?.verificado), puntos: f.pts, soyYo: f.u === usuario?.id };
      });
      let yo = null;
      if (usuario) {
        const siempre = totales(0).get(usuario.id) || { valoraciones: 0, tickets: 0, correcciones: 0, incidentes: 0, confirmacionesRecibidas: 0, votos: 0 };
        const t = { ...siempre, fiable: reputacion?.de(usuario.id).nivel === 'fiable' };
        const puesto = filas.findIndex((f) => f.u === usuario.id);
        yo = {
          puntosMes: puntosDe(mes.get(usuario.id) || siempre && { valoraciones: 0, tickets: 0, correcciones: 0, incidentes: 0, confirmacionesRecibidas: 0, votos: 0 }),
          puntosTotal: puntosDe(siempre),
          puesto: puesto >= 0 ? puesto + 1 : null,
          provincia: prov.get(usuario.id) || null,
          medallas: MEDALLAS.map((m) => ({ id: m.id, nombre: m.nombre, icono: m.icono, tiene: m.cumple(t) })),
          detalle: siempre,
        };
      }
      return { provincia: provincia || 'España', participantes: filas.length, ranking: lista, yo };
    },
  };
}
