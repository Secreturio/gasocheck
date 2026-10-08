/* GasoCheck — avisos: campana con la bandeja, alertas de precio y notificaciones en el dispositivo. */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NOMBRES = { gasoleoA: 'Diésel', gasoleoPremium: 'Gasoil+', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', glp: 'Autogás' };
  const ICONOS = { precio: '€', calidad: '⚠', gasolinera: '⛽' };
  const euros = (n) => Number(n).toFixed(3).replace('.', ',');

  async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(window.Cuenta ? Cuenta.cabeceras() : {}) },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status });
    return d;
  }
  const avisar = (m, ms) => window.GasoApp?.avisar(m, ms);
  const hace = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `hace ${Math.max(1, m)} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `hace ${h} h` : new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  };

  /* ---------- Campana ---------- */
  let sinLeer = 0;
  async function refrescar() {
    const u = window.Cuenta?.usuario();
    const b = $('#bAvisos');
    if (!b) return;
    b.hidden = !u;
    if (!u) return;
    try {
      const d = await api('/api/avisos');
      sinLeer = d.sinLeer;
      $('#nAvisos').textContent = sinLeer ? String(Math.min(99, sinLeer)) : '';
      b.setAttribute('aria-label', sinLeer ? `Avisos: ${sinLeer} sin leer` : 'Avisos');
    } catch {
      /* sin conexión */
    }
  }

  /* ---------- Notificaciones en este dispositivo ---------- */
  const soportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  async function suscripcionActual() {
    if (!soportaPush()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  const clave = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  async function activarPush() {
    if (!soportaPush()) throw new Error('Este navegador no admite notificaciones. En iPhone, añade GasoCheck a la pantalla de inicio y ábrelo desde ahí.');
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') throw new Error('Has bloqueado las notificaciones. Actívalas en los ajustes del navegador para GasoCheck.');
    const { clave: publica } = await api('/api/push/clave');
    const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clave(publica) }));
    await api('/api/push/suscribir', { metodo: 'POST', cuerpo: sub.toJSON() });
  }
  async function desactivarPush() {
    const sub = await suscripcionActual();
    if (!sub) return;
    await api('/api/push/desuscribir', { metodo: 'POST', cuerpo: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }

  /* ---------- Panel de avisos ---------- */
  async function abrir() {
    const p = $('#avisosPanel');
    if (!window.Cuenta?.usuario()) return window.Cuenta?.abrir();
    p.innerHTML = `<div class="ficha-cab"><button class="volver" type="button" id="cerrarAvisos">← Volver</button><div class="ficha-tit"><h2 id="avisosTitulo">Avisos</h2></div></div>
      <div class="cuerpo-cuenta" id="avisosCuerpo"><p class="texto-ayuda">Cargando…</p></div>`;
    p.hidden = false;
    window.GasoHoja?.('alto');
    $('#cerrarAvisos').addEventListener('click', () => {
      p.hidden = true;
      $('#bAvisos')?.focus();
    });
    $('#cerrarAvisos').focus({ preventScroll: true });
    try {
      const [{ avisos }, { alertas }, sub] = await Promise.all([api('/api/avisos'), api('/api/alertas'), suscripcionActual().catch(() => null)]);
      const notif = !soportaPush()
        ? '<p class="texto-ayuda">Este navegador no admite notificaciones. En iPhone, añade GasoCheck a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) y ábrelo desde ahí.</p>'
        : sub && Notification.permission === 'granted'
          ? '<p class="ok-cuenta">✓ Notificaciones activadas en este dispositivo</p><button type="button" class="boton" id="bPushNo">Desactivar en este dispositivo</button>'
          : '<p class="texto-ayuda">Actívalas para enterarte aunque no tengas la app abierta.</p><button type="button" class="boton primario" id="bPushSi">Activar notificaciones</button>';
      $('#avisosCuerpo').innerHTML = `
        <section class="bloque-cuenta sin-borde"><h3>Notificaciones</h3>${notif}</section>
        <section class="bloque-cuenta"><h3>Últimos avisos</h3>
          ${avisos.length
            ? `<ul class="lista-avisos">${avisos
                .map((a) => `<li class="${a.leido ? '' : 'nuevo'}" ${a.estacion ? `data-est="${esc(a.estacion)}" tabindex="0"` : ''}>
                  <span class="ico-aviso t-${esc(a.tipo)}" aria-hidden="true">${ICONOS[a.tipo] || '•'}</span>
                  <div><b>${esc(a.titulo)}</b><p>${esc(a.texto)}</p><small>${hace(a.fecha)}</small></div></li>`)
                .join('')}</ul>`
            : '<p class="texto-ayuda">Aún no tienes avisos. Crea una alerta de precio desde la ficha de una gasolinera, o guarda favoritas para enterarte si alguien reporta problemas de calidad.</p>'}
        </section>
        <section class="bloque-cuenta"><h3>Mis alertas de precio</h3>
          ${alertas.length
            ? `<ul class="lista-alertas">${alertas
                .map((a) => `<li><div><b>${esc(a.gasolinera?.rotulo || 'Gasolinera')}</b> · ${esc(a.gasolinera?.localidad || '')}<br><small>${NOMBRES[a.combustible] || a.combustible} por debajo de ${euros(a.umbral)} €${a.ultimo_precio != null ? ` · ahora ${euros(a.ultimo_precio)} €` : ''}</small></div>
                  <button type="button" class="enlace texto-peligro" data-borrar="${esc(a.id)}">Quitar</button></li>`)
                .join('')}</ul>`
            : '<p class="texto-ayuda">Ninguna. En la ficha de una gasolinera, pulsa “Avisarme si baja”.</p>'}
        </section>`;
      $$('[data-est]', p).forEach((li) => {
        const ir = () => {
          p.hidden = true;
          window.GasoApp?.abrirFicha(li.dataset.est);
        };
        li.addEventListener('click', ir);
        li.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), ir()));
      });
      $$('[data-borrar]', p).forEach((b) =>
        b.addEventListener('click', async () => {
          await api('/api/alertas/' + encodeURIComponent(b.dataset.borrar), { metodo: 'DELETE' }).catch((e) => avisar(e.message));
          b.closest('li').remove();
        })
      );
      $('#bPushSi')?.addEventListener('click', async () => {
        try {
          await activarPush();
          avisar('Notificaciones activadas');
          abrir();
        } catch (e) {
          avisar(e.message, 6000);
        }
      });
      $('#bPushNo')?.addEventListener('click', async () => {
        await desactivarPush();
        avisar('Notificaciones desactivadas en este dispositivo');
        abrir();
      });
      if (avisos.some((a) => !a.leido)) {
        await api('/api/avisos/leidos', { metodo: 'POST', cuerpo: {} });
        refrescar();
      }
    } catch (e) {
      $('#avisosCuerpo').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  /* ---------- Formulario "Avisarme si baja" (en la ficha) ---------- */
  function formularioAlerta(caja, estacion, combustible, precioActual) {
    const u = window.Cuenta?.usuario();
    if (!u) {
      caja.innerHTML = '<div class="aviso-cuenta"><p>Para recibir avisos de precio necesitas una cuenta.</p><button type="button" class="boton primario" data-entrar>Entrar o crear cuenta</button></div>';
      $('[data-entrar]', caja).addEventListener('click', () => window.Cuenta.abrir());
      return;
    }
    const sugerido = precioActual ? (Math.floor(precioActual * 100 - 2) / 100).toFixed(3).replace('.', ',') : '';
    caja.innerHTML = `<form class="form-correccion" novalidate>
      <p><b>Avísame cuando ${esc(NOMBRES[combustible] || combustible)} baje de…</b></p>
      <div class="fila-corr">
        <label for="alUmbral">Precio (€/l)<input id="alUmbral" inputmode="decimal" value="${sugerido}" autocomplete="off"></label>
        <div class="acciones" style="align-self:end"><button class="boton primario" type="submit">Crear aviso</button></div>
      </div>
      <p class="error" hidden></p>
    </form>`;
    $('#alUmbral', caja).focus();
    $('form', caja).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('.error', caja);
      try {
        await api('/api/alertas', { metodo: 'POST', cuerpo: { estacion, combustible, umbral: $('#alUmbral', caja).value.replace(',', '.') } });
        let extra = '';
        const sub = await suscripcionActual().catch(() => null);
        if (soportaPush() && !sub) {
          extra = '<button type="button" class="boton" data-push>Recibirlo también como notificación</button>';
        }
        caja.innerHTML = `<p class="ok-cuenta">✓ Te avisaremos cuando baje de ${esc($('#alUmbral', caja)?.value || '')} €. Lo verás en la campana${sub ? ' y como notificación' : ''}.</p>${extra}`;
        $('[data-push]', caja)?.addEventListener('click', async () => {
          try {
            await activarPush();
            avisar('Notificaciones activadas');
            $('[data-push]', caja).remove();
          } catch (e) {
            avisar(e.message, 6000);
          }
        });
        refrescar();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#bAvisos')?.addEventListener('click', abrir);
    setTimeout(refrescar, 1500);
    setInterval(refrescar, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refrescar());
    // Al pulsar una notificación con la app abierta, el service worker pide abrir la gasolinera
    navigator.serviceWorker?.addEventListener('message', (ev) => {
      if (ev.data?.tipo === 'abrir' && ev.data.estacion) window.GasoApp?.abrirFicha(ev.data.estacion);
      refrescar();
    });
  });

  window.GasoAvisos = { abrir, refrescar, formularioAlerta, activarPush };
})();
