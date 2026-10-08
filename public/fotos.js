/* GasoCheck — fotos de tickets de "Mis repostajes".
   Se guardan en el dispositivo (IndexedDB) y, si tienes cuenta, también en ella (privadas),
   para verlas en todos tus dispositivos. Antes de guardarlas se reducen para que ocupen poco. */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const urls = new Map(); // id -> objectURL
  let bd = null;

  function abrirBD() {
    if (bd) return bd;
    bd = new Promise((ok, ko) => {
      if (!('indexedDB' in window)) return ko(new Error('sin IndexedDB'));
      const r = indexedDB.open('gasocheck', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fotos');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    }).catch((e) => {
      bd = null;
      throw e;
    });
    return bd;
  }
  async function op(modo, fn) {
    const db = await abrirBD();
    return new Promise((ok, ko) => {
      const t = db.transaction('fotos', modo);
      const r = fn(t.objectStore('fotos'));
      t.oncomplete = () => ok(r?.result);
      t.onerror = () => ko(t.error);
    });
  }
  const local = {
    leer: (id) => op('readonly', (s) => s.get(id)).catch(() => null),
    guardar: (id, blob) => op('readwrite', (s) => s.put(blob, id)).catch(() => {}),
    borrar: (id) => op('readwrite', (s) => s.delete(id)).catch(() => {}),
  };

  const cabeceras = () => (window.Cuenta ? Cuenta.cabeceras() : {});
  const conCuenta = () => Boolean(window.Cuenta?.usuario());

  // Reduce la foto a 1400 px como máximo y la pasa a JPEG
  async function comprimir(fichero) {
    const img = await createImageBitmap(fichero);
    const escala = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escala);
    c.height = Math.round(img.height * escala);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.72));
  }
  const aDataURL = (blob) =>
    new Promise((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => ko(r.error);
      r.readAsDataURL(blob);
    });

  async function subir(id, blob) {
    if (!conCuenta()) return false;
    const res = await fetch(`${API}/api/cuenta/fotos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cabeceras() },
      body: JSON.stringify({ datos: await aDataURL(blob) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo subir la foto.');
    return true;
  }

  /** Guarda una foto. Devuelve { enCuenta }.
      directo: la imagen ya viene reducida (p. ej. del editor de fotos de perfil): no se vuelve a comprimir. */
  async function guardar(id, fichero, { directo = false } = {}) {
    const blob = directo ? fichero : await comprimir(fichero);
    await local.guardar(id, blob);
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.set(id, URL.createObjectURL(blob));
    let enCuenta = false;
    try {
      enCuenta = await subir(id, blob);
    } catch (e) {
      console.warn(e.message);
    }
    return { enCuenta };
  }

  /** URL para mostrar la foto (del dispositivo o, si no está, de la cuenta). null si no hay.
      fresco: se pide primero a la cuenta, sin usar ninguna copia guardada (para fotos con id fijo
      que otro dispositivo pudo cambiar). Sin conexión se usa la copia del dispositivo. */
  async function url(id, { fresco = false } = {}) {
    if (!fresco && urls.has(id)) return urls.get(id);
    let blob = null;
    if (fresco && conCuenta()) {
      try {
        const r = await fetch(`${API}/api/cuenta/fotos/${encodeURIComponent(id)}`, { headers: cabeceras(), cache: 'no-store' });
        if (r.ok) {
          blob = await r.blob();
          local.guardar(id, blob);
        }
      } catch {
        /* sin conexión */
      }
    }
    if (!blob) blob = await local.leer(id);
    if (!blob && !fresco && conCuenta()) {
      try {
        const r = await fetch(`${API}/api/cuenta/fotos/${encodeURIComponent(id)}`, { headers: cabeceras() });
        if (r.ok) {
          blob = await r.blob();
          local.guardar(id, blob);
        }
      } catch {
        /* sin conexión */
      }
    }
    if (!blob) return null;
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    const u = URL.createObjectURL(blob);
    urls.set(id, u);
    return u;
  }

  async function borrar(id) {
    await local.borrar(id);
    if (urls.has(id)) {
      URL.revokeObjectURL(urls.get(id));
      urls.delete(id);
    }
    if (conCuenta()) await fetch(`${API}/api/cuenta/fotos/${encodeURIComponent(id)}`, { method: 'DELETE', headers: cabeceras() }).catch(() => {});
  }

  // Visor a pantalla completa
  async function ver(id, titulo = 'Ticket') {
    const u = await url(id);
    if (!u) return window.GasoApp?.avisar('Esta foto no está disponible en este dispositivo.');
    const capa = document.createElement('div');
    capa.className = 'visor-foto';
    capa.setAttribute('role', 'dialog');
    capa.setAttribute('aria-modal', 'true');
    capa.setAttribute('aria-label', titulo);
    capa.innerHTML = `<button type="button" class="cerrar-visor" aria-label="Cerrar">✕</button><img alt="${titulo.replace(/"/g, '&quot;')}">`;
    capa.querySelector('img').src = u;
    const cerrar = () => {
      capa.remove();
      document.removeEventListener('keydown', tecla);
    };
    const tecla = (ev) => ev.key === 'Escape' && cerrar();
    capa.addEventListener('click', (ev) => (ev.target === capa || ev.target.closest('.cerrar-visor')) && cerrar());
    document.addEventListener('keydown', tecla);
    document.body.appendChild(capa);
    capa.querySelector('.cerrar-visor').focus();
  }

  // Al cerrar sesión: se borran del dispositivo las fotos de la cuenta (siguen en ella)
  async function vaciar() {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    await op('readwrite', (s) => s.clear()).catch(() => {});
  }

  window.GasoFotos = { guardar, url, borrar, ver, vaciar };
})();
