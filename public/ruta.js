/* GasoCheck — gasolineras más baratas a lo largo de una ruta (lo usa la pestaña GPS, gps.js).
   1) Calcula la ruta por carretera con OSRM (servidor configurable en config.js).
   2) Busca las gasolineras a menos de X km de la ruta.
   3) Ordena por coste total: lo que pagas al repostar + lo que gastas en el desvío (ida y vuelta). */
(() => {
  'use strict';
  const RAD = Math.PI / 180;
  const FACTOR_CARRETERA = 1.3; // la distancia real de un desvío es mayor que la línea recta

  // Distancia aproximada en km entre dos puntos [lat, lng] (válida para distancias cortas)
  function km(a, b) {
    const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * RAD);
    const y = b[0] - a[0];
    return Math.sqrt(x * x + y * y) * 111.32;
  }

  // Distancia de p al segmento a-b, y fracción t (0..1) del punto más cercano
  function aSegmento(p, a, b) {
    const cos = Math.cos(p[0] * RAD);
    const ax = a[1] * cos, ay = a[0], bx = b[1] * cos, by = b[0], px = p[1] * cos, py = p[0];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return { km: Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) * 111.32, t };
  }

  // Quita puntos muy seguidos para acelerar (la geometría de OSRM tiene miles)
  function simplificar(linea, minKm = 0.3) {
    const out = [linea[0]];
    for (let i = 1; i < linea.length - 1; i++) if (km(out[out.length - 1], linea[i]) >= minKm) out.push(linea[i]);
    out.push(linea[linea.length - 1]);
    return out;
  }

  /**
   * linea: [[lat, lng], …] · estaciones: [{ id, lat, lng, … }]
   * opciones: { maxDesvioKm, litros, consumo, precioDe(e) → €/l | null, n }
   * Devuelve [{ e, precio, desvioKm, kmDesdeOrigen, costeDesvio, coste }] ordenado por coste
   */
  function paradas(linea, estaciones, { maxDesvioKm = 3, litros = 50, consumo = 6.5, precioDe, n = 10 } = {}) {
    const L = simplificar(linea);
    const acumulado = [0];
    for (let i = 1; i < L.length; i++) acumulado.push(acumulado[i - 1] + km(L[i - 1], L[i]));
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [la, ln] of L) {
      minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
      minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln);
    }
    const mLat = maxDesvioKm / 111, mLng = maxDesvioKm / (111 * Math.cos(((minLat + maxLat) / 2) * RAD));
    const out = [];
    for (const e of estaciones) {
      if (e.lat < minLat - mLat || e.lat > maxLat + mLat || e.lng < minLng - mLng || e.lng > maxLng + mLng) continue;
      const p = precioDe(e);
      if (p == null) continue;
      let mejor = { km: Infinity, pos: 0 };
      for (let i = 1; i < L.length; i++) {
        const s = aSegmento([e.lat, e.lng], L[i - 1], L[i]);
        if (s.km < mejor.km) mejor = { km: s.km, pos: acumulado[i - 1] + s.t * (acumulado[i] - acumulado[i - 1]) };
      }
      if (mejor.km > maxDesvioKm) continue;
      const desvio = mejor.km * FACTOR_CARRETERA * 2;
      const costeDesvio = (desvio * consumo * p) / 100;
      out.push({ e, precio: p, desvioKm: Math.round(desvio * 10) / 10, kmDesdeOrigen: Math.round(mejor.pos), costeDesvio, coste: litros * p + costeDesvio });
    }
    return { total: Math.round(acumulado[acumulado.length - 1]), paradas: out.sort((a, b) => a.coste - b.coste).slice(0, n), candidatas: out.length };
  }

  const api = { paradas, km, simplificar };
  if (typeof window === 'undefined') return;
  window.GasoRuta = api;

  // La interfaz está en la pestaña GPS (gps.js), que usa paradas() para la parada más barata.
})();
