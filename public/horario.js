/* Interpreta los horarios del Ministerio y dice si una gasolinera está abierta ahora.
   Formatos habituales: "L-D: 24H", "L-V: 07:00-21:00; S: 08:00-14:00",
   "L-S: 06:00-14:00 y 16:00-22:00; D: 08:00-13:00", "L-D: 22:00-06:00" (cruza medianoche). */
(() => {
  'use strict';
  const LETRAS = 'LMXJVSD'; // lunes = 0 … domingo = 6
  const NOMBRES_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const cache = new Map();

  function dias(txt) {
    const out = new Set();
    for (const parte of txt.toUpperCase().replace(/\s/g, '').split(/[,y]/i)) {
      const m = parte.match(/^([LMXJVSD])(?:-([LMXJVSD]))?$/);
      if (!m) return null;
      const a = LETRAS.indexOf(m[1]);
      const b = m[2] ? LETRAS.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) {
        out.add(i);
        if (i === b) break;
      }
    }
    return out.size ? [...out] : null;
  }

  // Devuelve una semana: 7 listas de tramos [inicioMin, finMin] (fin > 1440 si cruza medianoche), o null
  function interpretar(horario) {
    if (!horario) return null;
    if (cache.has(horario)) return cache.get(horario);
    const semana = Array.from({ length: 7 }, () => []);
    let algo = false;
    for (const seg of horario.split(';')) {
      const m = seg.match(/^\s*([LMXJVSD][LMXJVSDy,\-\s]*?)\s*:\s*(.+)$/i);
      if (!m) continue;
      const ds = dias(m[1]);
      if (!ds) continue;
      const tramos = [];
      if (/24\s*H/i.test(m[2])) tramos.push([0, 1440]);
      for (const t of m[2].matchAll(/(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})/g)) {
        const ini = +t[1] * 60 + +t[2];
        let fin = +t[3] * 60 + +t[4];
        if (fin <= ini) fin += 1440;
        tramos.push([ini, fin]);
      }
      if (!tramos.length) continue;
      for (const d of ds) semana[d].push(...tramos);
      algo = true;
    }
    const res = algo ? semana : null;
    cache.set(horario, res);
    return res;
  }

  const zona = (provincia = '') => (/palmas|tenerife/i.test(provincia) ? 'Atlantic/Canary' : 'Europe/Madrid');
  const fmtCache = {};
  function ahoraEn(tz, fecha) {
    const f = (fmtCache[tz] ||= new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    const p = Object.fromEntries(f.formatToParts(fecha).map((x) => [x.type, x.value]));
    const d = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
    return { dia: d, min: (+p.hour % 24) * 60 + +p.minute };
  }
  const hhmm = (m) => {
    m = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  /**
   * estado(horario, provincia, fecha?) →
   *   null                                  si no se entiende el horario
   *   { abierta: true,  texto: 'Abierta 24 h' | 'Abierta hasta las 22:00' }
   *   { abierta: false, texto: 'Cerrada · abre a las 07:00' | '… mañana a las 07:00' | '… el lunes a las 07:00' }
   */
  function estado(horario, provincia, fecha = new Date()) {
    const sem = interpretar(horario);
    if (!sem) return null;
    const siempre = sem.every((d) => d.some(([a, b]) => a === 0 && b >= 1440));
    if (siempre) return { abierta: true, texto: 'Abierta 24 h' };

    const { dia, min } = ahoraEn(zona(provincia), fecha);
    const ayer = (dia + 6) % 7;

    // ¿Abierta por un tramo de hoy o por uno de ayer que cruza la medianoche?
    let hasta = null;
    for (const [a, b] of sem[dia]) if (min >= a && min < b) hasta = Math.max(hasta ?? 0, b);
    for (const [, b] of sem[ayer]) if (b > 1440 && min < b - 1440) hasta = Math.max(hasta ?? 0, b - 1440);
    if (hasta !== null) {
      // Si cierra a medianoche y mañana abre a las 00:00, sigue abierta
      if (hasta >= 1440 && sem[(dia + 1) % 7].some(([a]) => a === 0)) return { abierta: true, texto: 'Abierta, sin cierre esta noche' };
      return { abierta: true, texto: `Abierta hasta las ${hhmm(hasta)}` };
    }

    // Cerrada: buscar la próxima apertura
    const hoy = sem[dia].filter(([a]) => a > min).map(([a]) => a);
    if (hoy.length) return { abierta: false, texto: `Cerrada · abre a las ${hhmm(Math.min(...hoy))}` };
    for (let k = 1; k <= 7; k++) {
      const d = (dia + k) % 7;
      if (sem[d].length) {
        const a = Math.min(...sem[d].map(([x]) => x));
        const cuando = k === 1 ? 'mañana' : `el ${NOMBRES_DIA[d]}`;
        return { abierta: false, texto: `Cerrada · abre ${cuando} a las ${hhmm(a)}` };
      }
    }
    return { abierta: false, texto: 'Cerrada' };
  }

  const api = { estado, interpretar };
  if (typeof window !== 'undefined') window.Horario = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
