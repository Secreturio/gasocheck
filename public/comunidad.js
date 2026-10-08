/* GasoCheck — puntos, medallas y ranking del mes (en Estadísticas).
   Los puntos salen de lo que cada persona aporta: valorar (10, +10 con ticket), corregir precios (5),
   avisar de incidentes en el GPS (5, +2 por confirmación) y confirmar avisos de otros (2). */
(() => {
  'use strict';
  const API = () => (window.GASOCHECK_API || '').replace(/\/$/, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mes = () => new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'Europe/Madrid' }).format(new Date());

  async function pedir(provincia) {
    const r = await fetch(`${API()}/api/ranking${provincia ? '?provincia=' + encodeURIComponent(provincia) : ''}`, { headers: window.Cuenta?.cabeceras?.() || {} });
    if (!r.ok) throw new Error('ranking');
    return r.json();
  }

  async function pintar(el, provincia = '') {
    if (!el) return;
    el.innerHTML = `<h3>Ranking de ${esc(mes())}</h3><p class="texto-ayuda">Cargando…</p>`;
    let d;
    try {
      d = await pedir(provincia);
    } catch {
      el.innerHTML = `<h3>Ranking de ${esc(mes())}</h3><p class="texto-ayuda">No se pudo cargar el ranking.</p>`;
      return;
    }
    const yo = d.yo;
    const logueado = Boolean(window.Cuenta?.usuario?.());
    el.innerHTML = `
      <div class="bloque-cab"><h3>Ranking de ${esc(mes())} · ${esc(d.provincia)}</h3></div>
      ${
        yo
          ? `<div class="mis-puntos">
              <div><strong>${yo.puntosMes}</strong><span>puntos este mes${yo.puesto ? ` · puesto ${yo.puesto}` : ''}</span></div>
              <div><strong>${yo.puntosTotal}</strong><span>en total${yo.provincia ? ` · ${esc(yo.provincia)}` : ''}</span></div>
            </div>
            <div class="medallas">${yo.medallas
              .map((m) => `<span class="medalla${m.tiene ? ' tiene' : ''}" title="${esc(m.nombre)}${m.tiene ? '' : ' (aún no)'}"><b>${m.icono}</b>${esc(m.nombre)}</span>`)
              .join('')}</div>`
          : `<p class="texto-ayuda">${logueado ? 'Aún no tienes puntos este mes.' : 'Entra en tu cuenta para sumar puntos y medallas.'} Valorar una gasolinera son 10 puntos (20 con ticket), corregir un precio 5, avisar de un incidente en el GPS 5 y confirmar los de otros 2.</p>`
      }
      ${
        d.ranking.length
          ? `<ol class="ranking">${d.ranking
              .map((f) => `<li class="${f.soyYo ? 'yo' : ''}"><span class="puesto">${f.puesto <= 3 ? ['🥇', '🥈', '🥉'][f.puesto - 1] : f.puesto}</span><span class="alias">${esc(f.alias)}${f.verificado ? ' <span class="ok">✓</span>' : ''}</span><b>${f.puntos}</b></li>`)
              .join('')}</ol>`
          : `<p class="texto-ayuda">Nadie ha sumado puntos este mes en ${esc(d.provincia)}. ¡Puedes ser el primero!</p>`
      }`;
  }

  window.GasoPuntos = { pintar };
})();
