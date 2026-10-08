// "¿Lleno ahora o espero?": consejo a partir del historial de precios medios (España o provincia).
// Mira dos cosas: la tendencia de la última semana y si algún día de la semana suele ser más barato.
// Es orientativo: el historial explica el pasado, no garantiza el futuro.

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const diaSemana = (iso) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7; // lunes = 0
const cent = (eur) => Math.round(eur * 1000) / 10; // € → céntimos con un decimal

/**
 * serie: [{ dia: 'AAAA-MM-DD', gasoleoA: 1.45, … }] ordenada por día. hoy: 'AAAA-MM-DD'
 * Devuelve { decision: 'ahora' | 'esperar' | 'igual' | 'sin_datos', titulo, texto, datos }
 */
export function consejo(serie, combustible, hoy) {
  const pts = serie.filter((p) => p[combustible] != null).map((p) => ({ dia: p.dia, v: p[combustible] }));
  if (pts.length < 14) {
    return { decision: 'sin_datos', titulo: 'Aún no hay historial suficiente', texto: 'Con dos semanas de precios podremos aconsejarte cuándo repostar.', datos: { dias: pts.length } };
  }

  // Tendencia: pendiente de la recta de los últimos 8 días (€/día)
  const ult = pts.slice(-8);
  const n = ult.length;
  const xm = (n - 1) / 2;
  const ym = ult.reduce((a, p) => a + p.v, 0) / n;
  let num = 0, den = 0;
  ult.forEach((p, i) => {
    num += (i - xm) * (p.v - ym);
    den += (i - xm) ** 2;
  });
  const pendiente = num / den;
  const cambio7 = ult[n - 1].v - ult[0].v;

  // Patrón semanal: diferencia media de cada día respecto a la media de su semana (últimas 8 semanas)
  const recientes = pts.slice(-56);
  const desv = Array.from({ length: 7 }, () => []);
  for (let i = 3; i < recientes.length - 3; i++) {
    const ventana = recientes.slice(i - 3, i + 4);
    const media = ventana.reduce((a, p) => a + p.v, 0) / ventana.length;
    desv[diaSemana(recientes[i].dia)].push(recientes[i].v - media);
  }
  const patron = desv.map((l) => (l.length >= 2 ? l.reduce((a, b) => a + b, 0) / l.length : null));
  const validos = patron.filter((x) => x != null);
  const rango = validos.length >= 5 ? Math.max(...validos) - Math.min(...validos) : 0;
  const hoyDia = diaSemana(hoy);
  let mejorDia = null;
  // El día más barato de los próximos 3
  for (let k = 0; k <= 3; k++) {
    const d = (hoyDia + k) % 7;
    if (patron[d] == null) continue;
    if (mejorDia == null || patron[d] < patron[mejorDia.d] - 1e-9) mejorDia = { d, k };
  }
  const ahorroDia = mejorDia && patron[hoyDia] != null ? patron[hoyDia] - patron[mejorDia.d] : 0;

  const datos = { pendienteCentDia: cent(pendiente), cambio7Cent: cent(cambio7), patronCent: patron.map((x) => (x == null ? null : cent(x))), rangoSemanaCent: cent(rango) };

  if (pendiente <= -0.0015) {
    return { decision: 'esperar', titulo: 'Los precios están bajando', texto: `Han bajado ${Math.abs(cent(cambio7)).toLocaleString('es-ES')} céntimos en la última semana. Si no tienes prisa, espera unos días.`, datos };
  }
  if (pendiente >= 0.0015) {
    return { decision: 'ahora', titulo: 'Los precios están subiendo', texto: `Han subido ${cent(cambio7).toLocaleString('es-ES')} céntimos en la última semana. Mejor llena hoy.`, datos };
  }
  if (rango >= 0.006 && mejorDia && mejorDia.k > 0 && ahorroDia >= 0.004) {
    const cuando = mejorDia.k === 1 ? 'mañana' : `el ${DIAS[mejorDia.d]}`;
    return { decision: 'esperar', titulo: `Suele ser más barato ${cuando}`, texto: `Precios estables, pero ${cuando} suele costar unos ${cent(ahorroDia).toLocaleString('es-ES')} céntimos menos por litro.`, datos };
  }
  if (rango >= 0.006 && mejorDia && mejorDia.k === 0) {
    return { decision: 'ahora', titulo: 'Hoy es buen día', texto: `Precios estables y hoy suele ser de los días más baratos de la semana.`, datos };
  }
  return { decision: 'igual', titulo: 'Precios estables', texto: 'No hay una tendencia clara: puedes repostar cuando te venga bien.', datos };
}
