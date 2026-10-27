/* GasoCheck — Elegir un punto exacto en el mapa (para tus lugares y talleres).
   Se abre un mapa con un pin fijo en el centro: mueves el mapa hasta dejar el pin justo en el sitio
   y se guarda esa posición (con la dirección más cercana, si se encuentra).
   Uso: const p = await GasoMapa.elegirPunto({ lat, lng, titulo }); → { lat, lng, dir } o null si cancelas */
(() => {
  'use strict';
  const GEOCODER = (window.GASOCHECK_GEOCODER || 'https://photon.komoot.io').replace(/\/$/, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const A = () => window.GasoApp;

  // Dirección aproximada de un punto (calle y número si se conocen)
  async function direccionDe(lat, lng, signal) {
    try {
      const r = await fetch(`${GEOCODER}/reverse?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&lang=default`, { signal });
      const d = await r.json();
      const p = d.features?.[0]?.properties;
      if (!p) return '';
      const calle = [p.street, p.housenumber].filter(Boolean).join(' ');
      const sitio = p.name && p.name !== p.street ? p.name : '';
      return [sitio, calle, [p.postcode, p.city || p.town || p.village || p.district].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    } catch {
      return '';
    }
  }

  // Las mismas teselas que el mapa principal
  function teselas() {
    let capa = null;
    A()?.mapa?.eachLayer((l) => {
      if (!capa && l instanceof L.TileLayer) capa = l;
    });
    return capa ? { url: capa._url, opciones: { ...capa.options, pane: 'tilePane' } } : { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opciones: { maxZoom: 19, attribution: '© OpenStreetMap' } };
  }

  function elegirPunto({ lat, lng, titulo = 'Coloca el pin en el sitio exacto', zoom = 18 } = {}) {
    return new Promise((ok) => {
      const yo = A()?.estado?.yo;
      const centro = Number.isFinite(lat) ? [lat, lng] : yo ? [yo.lat, yo.lng] : (() => {
        const c = A()?.mapa?.getCenter();
        return c ? [c.lat, c.lng] : [40.4168, -3.7038];
      })();
      const capa = document.createElement('div');
      capa.className = 'ep-capa';
      capa.setAttribute('role', 'dialog');
      capa.setAttribute('aria-modal', 'true');
      capa.setAttribute('aria-label', titulo);
      capa.innerHTML = `<div class="ep-caja">
        <div class="ep-cab"><div><h3>${esc(titulo)}</h3><p>Mueve el mapa hasta dejar el pin justo encima. Acerca con dos dedos o con la rueda.</p></div><button type="button" class="ep-x" aria-label="Cancelar">✕</button></div>
        <div class="ep-mapa-caja"><div class="ep-mapa"></div><div class="ep-pin" aria-hidden="true"><svg viewBox="0 0 24 34"><path d="M12 33s11-11.6 11-20.5A11 11 0 0 0 1 12.5C1 21.4 12 33 12 33z"/><circle cx="12" cy="12.5" r="4.2"/></svg></div>
          <button type="button" class="ep-yo" title="Ir a mi ubicación" aria-label="Ir a mi ubicación"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg></button></div>
        <div class="ep-pie"><p class="ep-dir" aria-live="polite">Buscando la dirección…</p>
          <div class="ep-botones"><button type="button" class="boton primario ep-usar">Usar esta ubicación</button><button type="button" class="boton ep-cancelar">Cancelar</button></div></div>
      </div>`;
      document.body.appendChild(capa);
      document.body.classList.add('con-hoja');
      const t = teselas();
      const mapa = L.map(capa.querySelector('.ep-mapa'), { zoomControl: true, attributionControl: true }).setView(centro, zoom);
      mapa.attributionControl.setPrefix(false);
      L.tileLayer(t.url, t.opciones).addTo(mapa);
      setTimeout(() => mapa.invalidateSize(), 60);
      let dir = '';
      let ctrl = null;
      let temp = null;
      const actualizarDir = () => {
        clearTimeout(temp);
        ctrl?.abort();
        capa.querySelector('.ep-dir').textContent = 'Buscando la dirección…';
        temp = setTimeout(async () => {
          ctrl = new AbortController();
          const c = mapa.getCenter();
          dir = await direccionDe(c.lat, c.lng, ctrl.signal);
          capa.querySelector('.ep-dir').textContent = dir ? `📍 ${dir}` : `📍 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
        }, 450);
      };
      mapa.on('movestart', () => capa.classList.add('moviendo'));
      mapa.on('moveend', () => {
        capa.classList.remove('moviendo');
        actualizarDir();
      });
      actualizarDir();
      let hecho = false;
      const fin = (v) => {
        if (hecho) return;
        hecho = true;
        clearTimeout(temp);
        ctrl?.abort();
        mapa.remove();
        capa.remove();
        if (!document.querySelector('.hoja-modal, .ep-capa')) document.body.classList.remove('con-hoja');
        document.removeEventListener('keydown', tecla);
        ok(v);
      };
      const tecla = (ev) => ev.key === 'Escape' && fin(null);
      document.addEventListener('keydown', tecla);
      capa.querySelector('.ep-x').addEventListener('click', () => fin(null));
      capa.querySelector('.ep-cancelar').addEventListener('click', () => fin(null));
      capa.querySelector('.ep-usar').addEventListener('click', () => {
        const c = mapa.getCenter();
        fin({ lat: Math.round(c.lat * 1e6) / 1e6, lng: Math.round(c.lng * 1e6) / 1e6, dir: dir || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` });
      });
      capa.querySelector('.ep-yo').addEventListener('click', () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition((p) => mapa.setView([p.coords.latitude, p.coords.longitude], 18), () => A()?.avisar('No se pudo obtener tu ubicación.'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
      });
    });
  }

  window.GasoMapa = { elegirPunto, direccionDe };
})();
