/* GasoCheck — ver un viaje compartido en directo (viaje.html?id=…). Se actualiza cada 10 segundos. */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const id = new URLSearchParams(location.search).get('id') || '';
  const $ = (s) => document.querySelector(s);
  const hora = (t) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const hace = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'hace unos segundos' : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
  };

  const mapa = L.map('mapa', { zoomControl: false }).setView([40.2, -3.7], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>' }).addTo(mapa);
  let yo = null, meta = null, encuadrado = false;

  async function actualizar() {
    let v;
    try {
      const r = await fetch(`${API}/api/viajes/${encodeURIComponent(id)}`, { cache: 'no-store' });
      v = await r.json();
      if (!r.ok) throw new Error(v.error || 'Este viaje ya no se está compartiendo.');
    } catch (e) {
      $('#titulo').textContent = 'Viaje no disponible';
      $('#sub').textContent = e.message;
      $('#eta').hidden = true;
      return false;
    }
    $('#titulo').textContent = v.terminado ? `${v.quien} ha llegado` : `${v.quien} va de camino`;
    $('#sub').textContent = `Destino: ${v.destino.nombre}`;
    if (!meta) meta = L.marker([v.destino.lat, v.destino.lng], { icon: L.divIcon({ className: '', html: '<div class="meta">🏁</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(mapa);
    if (v.pos) {
      const p = [v.pos.lat, v.pos.lng];
      if (!yo) yo = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="punto"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(mapa);
      yo.setLatLng(p);
      if (!encuadrado) {
        mapa.fitBounds(L.latLngBounds([p, [v.destino.lat, v.destino.lng]]), { padding: [60, 60], maxZoom: 15 });
        encuadrado = true;
      }
      $('#nota').textContent = `Posición actualizada ${hace(v.pos.t)}.`;
    } else {
      $('#nota').textContent = 'Esperando la primera posición…';
      if (!encuadrado) mapa.setView([v.destino.lat, v.destino.lng], 12);
    }
    const conEta = !v.terminado && v.eta;
    $('#eta').hidden = !conEta;
    if (conEta) {
      $('#hora').textContent = hora(v.eta);
      $('#resto').textContent = v.restoKm != null ? `${String(v.restoKm).replace('.', ',')} km` : '—';
    }
    return !v.terminado;
  }

  (async function bucle() {
    const seguir = await actualizar();
    if (seguir !== false) setTimeout(bucle, 10000);
  })();
})();
