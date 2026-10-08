/* GasoCheck — gasolinera más barata en tu ruta.
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

  /* ---------------- Interfaz ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const SERVIDOR = (window.GASOCHECK_RUTAS || 'https://router.project-osrm.org').replace(/\/$/, '');
  let capa = null;
  let marcas = null;

  function lugarDe(texto) {
    const A = window.GasoApp;
    const t = A.norm(texto).trim();
    if (!t) return null;
    if (/^mi ubicacion|^aqui$/.test(t)) return A.estado.yo ? { nombre: 'Tu ubicación', lat: A.estado.yo.lat, lng: A.estado.yo.lng } : 'sin-ubicacion';
    const cands = A.estado.lugares.filter((l) => l._n === t || l._n.startsWith(t));
    if (!cands.length) return null;
    const l = cands.sort((a, b) => (a._n === t) - (b._n === t) || a.tipo.localeCompare(b.tipo) || b.n - a.n).reverse()[0];
    return { nombre: l.nombre, lat: (l.nn + l.s) / 2, lng: (l.w + l.ee) / 2 };
  }

  async function calcular(origen, destino) {
    const url = `${SERVIDOR}/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=full&geometries=geojson`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const d = await r.json();
      if (d.code !== 'Ok' || !d.routes?.length) throw new Error('sin ruta');
      const ruta = d.routes[0];
      return { linea: ruta.geometry.coordinates.map(([lng, lat]) => [lat, lng]), km: ruta.distance / 1000, min: ruta.duration / 60, aproximada: false };
    } catch {
      // Sin servicio de rutas: línea recta (menos precisa)
      const linea = [[origen.lat, origen.lng], [destino.lat, destino.lng]];
      return { linea, km: km(linea[0], linea[1]) * 1.25, min: null, aproximada: true };
    }
  }

  function limpiar() {
    const A = window.GasoApp;
    if (capa) A.mapa.removeLayer(capa);
    if (marcas) A.mapa.removeLayer(marcas);
    capa = marcas = null;
  }

  function pintarFormulario() {
    const A = window.GasoApp;
    const caja = $('#rutaCaja');
    const ultimo = (() => { try { return JSON.parse(localStorage.getItem('gm.ruta')) || {}; } catch { return {}; } })();
    caja.innerHTML = `<form class="form-ruta" id="fRuta" novalidate>
      <div class="fila-ruta">
        <label for="rOrigen">Desde<input id="rOrigen" list="rLugares" autocomplete="off" placeholder="Municipio o “Mi ubicación”" value="${A.esc(ultimo.o || (A.estado.yo ? 'Mi ubicación' : ''))}"></label>
        <label for="rDestino">Hasta<input id="rDestino" list="rLugares" autocomplete="off" placeholder="Municipio de destino" value="${A.esc(ultimo.d || '')}"></label>
      </div>
      <datalist id="rLugares"><option value="Mi ubicación">${A.estado.lugares.filter((l) => l.tipo === 'municipio' && l.n >= 3).sort((a, b) => b.n - a.n).slice(0, 400).map((l) => `<option value="${A.esc(l.nombre)}">`).join('')}</datalist>
      <div class="fila-ruta">
        <label for="rDesvio">Desvío máximo<select id="rDesvio"><option value="1">1 km</option><option value="3" selected>3 km</option><option value="5">5 km</option><option value="10">10 km</option></select></label>
        <label for="rLitros">Litros a repostar<input id="rLitros" inputmode="decimal" value="${String(A.estado.ajustes.litros).replace('.', ',')}"></label>
      </div>
      <p class="error" hidden></p>
      <div class="acciones"><button class="boton primario" type="submit">Buscar en la ruta</button><button class="boton" type="button" id="rCerrar">Cerrar</button></div>
    </form>
    <div id="rutaRes" aria-live="polite"></div>`;
    $('#rCerrar').addEventListener('click', () => {
      caja.hidden = true;
      $('#bRuta').setAttribute('aria-expanded', 'false');
      limpiar();
    });
    $('#fRuta').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('.error', caja);
      err.hidden = true;
      const o = lugarDe($('#rOrigen').value), d = lugarDe($('#rDestino').value);
      const fallo = (m) => { err.textContent = m; err.hidden = false; };
      if (o === 'sin-ubicacion' || d === 'sin-ubicacion') {
        A.localizar();
        return fallo('Activa tu ubicación (botón de la diana) y vuelve a intentarlo.');
      }
      if (!o) return fallo('No encuentro el origen. Escribe un municipio con gasolineras, por ejemplo “Valladolid”.');
      if (!d) return fallo('No encuentro el destino. Escribe un municipio, por ejemplo “Burgos”.');
      try { localStorage.setItem('gm.ruta', JSON.stringify({ o: $('#rOrigen').value, d: $('#rDestino').value })); } catch { /* */ }
      const res = $('#rutaRes');
      res.innerHTML = '<p class="texto-ayuda">Calculando la ruta…</p>';
      const ruta = await calcular(o, d);
      const c = A.estado.combustible;
      const litros = parseFloat(String($('#rLitros').value).replace(',', '.')) || A.estado.ajustes.litros;
      const r = paradas(ruta.linea, A.estado.estaciones.filter((e) => e.venta === 'publico'), {
        maxDesvioKm: +$('#rDesvio').value,
        litros,
        consumo: A.estado.ajustes.consumo,
        precioDe: (e) => A.precio(e, c),
        n: 8,
      });
      limpiar();
      capa = L.polyline(ruta.linea, { color: getComputedStyle(document.documentElement).getPropertyValue('--acento').trim() || '#1b4fa8', weight: 5, opacity: 0.8 }).addTo(A.mapa);
      marcas = L.layerGroup(
        r.paradas.slice(0, 3).map((p, i) => L.circleMarker([p.e.lat, p.e.lng], { radius: 11, color: '#fff', weight: 3, fillColor: i === 0 ? '#1f8a4c' : '#b7791f', fillOpacity: 1 }).bindTooltip(`${i + 1}. ${A.euros(p.precio)} €`, { permanent: true, direction: 'top' }))
      ).addTo(A.mapa);
      A.mapa.fitBounds(capa.getBounds(), { padding: [30, 30] });
      A.hoja('medio');
      if (!r.paradas.length) {
        res.innerHTML = `<p class="texto-ayuda">No hay gasolineras con ${A.NOMBRES[c]} a menos de ${$('#rDesvio').value} km de la ruta. Prueba con un desvío mayor.</p>`;
        return;
      }
      const peor = Math.max(...r.paradas.map((p) => p.coste));
      res.innerHTML = `<p class="resumen-ruta"><b>${o.nombre} → ${d.nombre}</b>: ${Math.round(ruta.km)} km${ruta.min ? ` · ${Math.floor(ruta.min / 60) ? Math.floor(ruta.min / 60) + ' h ' : ''}${Math.round(ruta.min % 60)} min` : ''}. ${r.candidatas} gasolineras en el camino.${ruta.aproximada ? '<br><span class="texto-peligro">No se pudo calcular la ruta por carretera: se usa una línea recta y los resultados son aproximados.</span>' : ''}</p>
        <ol class="lista lista-ruta">${r.paradas
          .map((p, i) => `<li class="fila" tabindex="0" data-ruta="${A.esc(p.e.id)}">
            <span class="nombre">${i + 1}. ${A.esc(p.e.rotulo)}</span>
            <span class="precio">${A.euros(p.precio)}<small>€/litro</small></span>
            <span class="dir">${A.esc(p.e.localidad)} · a ${p.kmDesdeOrigen} km de la salida · desvío ${String(p.desvioKm).replace('.', ',')} km</span>
            <span class="meta"><b>${A.euros(p.coste, 2)} €</b> llenando ${String(litros).replace('.', ',')} L con el desvío${i === 0 && peor - p.coste >= 0.5 ? ` · <span class="ok">${A.euros(peor - p.coste, 2)} € menos que la ${r.paradas.length}.ª</span>` : ''}</span>
          </li>`)
          .join('')}</ol>`;
      res.querySelectorAll('[data-ruta]').forEach((li) => {
        const abrir = () => A.abrirFicha(li.dataset.ruta);
        li.addEventListener('click', abrir);
        li.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), abrir()));
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const b = $('#bRuta');
    b?.addEventListener('click', () => {
      const caja = $('#rutaCaja');
      const abrir = caja.hidden;
      caja.hidden = !abrir;
      b.setAttribute('aria-expanded', String(abrir));
      if (abrir) {
        pintarFormulario();
        window.GasoApp?.hoja('alto');
        $('#rDestino').focus();
      } else limpiar();
    });
  });
})();
