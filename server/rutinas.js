// Avisos automáticos que se revisan con cada actualización de precios:
// - Precio del día: cada mañana (8:00), la gasolinera más barata cerca de tu casa.
// - Rutas vigiladas: aviso cuando baja el precio en una ruta guardada (p. ej. casa → trabajo).
// La configuración la guarda cada persona en sus ajustes (se sincronizan con la cuenta):
//   ajustes.gpsCasa = { nombre, lat, lng }
//   ajustes.precioDia = { activo, combustible, radio }
//   ajustes.gpsRutas = [{ id, nombre, combustible, estaciones: [ids] }]
// Lo que ya se ha avisado se apunta en la tabla avisos_estado para no repetir.

const NOMBRES = { gasoleoA: 'Gasóleo A', gasoleoPremium: 'Gasóleo Premium', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', glp: 'Autogás' };
const eur = (n) => n.toFixed(3).replace('.', ',');
const kmEntre = (a, b) => {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111.32;
};

export function crearRutinas(db, { avisos }) {
  const leerEstado = (u, clave) => {
    const f = db.uno('SELECT valor FROM avisos_estado WHERE usuario = ? AND clave = ?', u, clave);
    if (!f) return null;
    try {
      return JSON.parse(f.valor);
    } catch {
      return null;
    }
  };
  const fijarEstado = (u, clave, valor) =>
    db.ejecutar(
      `INSERT INTO avisos_estado (usuario, clave, valor, fecha) VALUES (?, ?, ?, ?)
       ON CONFLICT(usuario, clave) DO UPDATE SET valor = excluded.valor, fecha = excluded.fecha`,
      u, clave, JSON.stringify(valor), Date.now()
    );

  function ajustesDeTodos() {
    const out = [];
    for (const f of db.todos('SELECT usuario, datos FROM sync')) {
      try {
        const a = JSON.parse(f.datos)?.ajustes;
        if (a && typeof a === 'object') out.push({ usuario: f.usuario, a });
      } catch {
        /* datos dañados */
      }
    }
    return out;
  }

  return {
    // Cada mañana: la más barata cerca de casa (una vez al día por persona)
    async precioDelDia(datos, dia) {
      let n = 0;
      for (const { usuario, a } of ajustesDeTodos()) {
        const pd = a.precioDia;
        const casa = a.gpsCasa;
        if (!pd?.activo || !Number.isFinite(casa?.lat) || !Number.isFinite(casa?.lng)) continue;
        if (leerEstado(usuario, 'precioDia') === dia) continue;
        const c = NOMBRES[pd.combustible] ? pd.combustible : 'gasoleoA';
        const radio = Math.min(30, Math.max(1, Number(pd.radio) || 5));
        let mejor = null;
        for (const e of datos.estaciones) {
          if (e.venta !== 'publico' || e.precios[c] == null) continue;
          if (Math.abs(e.lat - casa.lat) > radio / 100 || Math.abs(e.lng - casa.lng) > radio / 70) continue;
          const km = kmEntre(casa, e);
          if (km > radio) continue;
          if (!mejor || e.precios[c] < mejor.e.precios[c] || (e.precios[c] === mejor.e.precios[c] && km < mejor.km)) mejor = { e, km };
        }
        fijarEstado(usuario, 'precioDia', dia);
        if (!mejor) continue;
        await avisos.notificar(usuario, {
          tipo: 'precio',
          titulo: `Buenos días: ${NOMBRES[c]} a ${eur(mejor.e.precios[c])} €`,
          texto: `La más barata cerca de casa hoy es ${mejor.e.rotulo} (${mejor.e.localidad}), a ${mejor.km.toFixed(1).replace('.', ',')} km.`,
          estacion: mejor.e.id,
        });
        n++;
      }
      return n;
    },

    // Rutas vigiladas: avisa si el precio más bajo de la ruta baja al menos 1 céntimo (como mucho uno cada 12 h)
    async rutasVigiladas(precioActual, nombreDe) {
      let n = 0;
      for (const { usuario, a } of ajustesDeTodos()) {
        const rutas = Array.isArray(a.gpsRutas) ? a.gpsRutas.slice(0, 10) : [];
        for (const r of rutas) {
          if (!r?.id || !Array.isArray(r.estaciones) || !r.estaciones.length) continue;
          const c = NOMBRES[r.combustible] ? r.combustible : 'gasoleoA';
          let min = null;
          for (const id of r.estaciones.slice(0, 400)) {
            const p = precioActual(String(id), c);
            if (p != null && (!min || p < min.p)) min = { p, id: String(id) };
          }
          if (!min) continue;
          const clave = 'ruta:' + String(r.id).slice(0, 40);
          const antes = leerEstado(usuario, clave);
          const baja = antes?.min != null && min.p <= antes.min - 0.0095;
          const puede = !antes?.aviso || Date.now() - antes.aviso > 12 * 3600 * 1000;
          if (baja && puede) {
            await avisos.notificar(usuario, {
              tipo: 'precio',
              titulo: `Baja el precio en «${String(r.nombre || 'tu ruta').slice(0, 40)}»`,
              texto: `${NOMBRES[c]} a ${eur(min.p)} € en ${nombreDe(min.id)} (${String(Math.round((antes.min - min.p) * 1000) / 10).replace('.', ',')} cént. menos).`,
              estacion: min.id,
            });
            n++;
          }
          fijarEstado(usuario, clave, { min: min.p, aviso: baja && puede ? Date.now() : antes?.aviso || null });
        }
      }
      return n;
    },
  };
}
