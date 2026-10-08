/* Gráficas SVG ligeras (sin librerías). Los colores salen de clases CSS con tokens del tema. */
(() => {
  'use strict';
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const diaNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  const etiquetaDia = (s) => `${+s.slice(8, 10)} ${MESES[+s.slice(5, 7) - 1]}`;
  const eur = (n, dec = 3) => n.toFixed(dec).replace('.', ',');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * series: [{ nombre, clase, puntos: [{ x: 'AAAA-MM-DD', y: número }] }]
   * La primera serie es la principal (se marca su último valor).
   */
  function linea(series, { alto = 160, titulo = '' } = {}) {
    const validas = series.filter((s) => s.puntos.length);
    const todos = validas.flatMap((s) => s.puntos);
    if (todos.length < 2) return '<p class="texto-ayuda">Aún no hay suficiente historial. Se completa con un dato al día.</p>';

    const W = 360, H = alto, L = 46, R = 14, T = 14, B = 24;
    const xs = todos.map((p) => diaNum(p.x));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...todos.map((p) => p.y));
    let y1 = Math.max(...todos.map((p) => p.y));
    const margen = Math.max((y1 - y0) * 0.15, 0.005);
    y0 -= margen;
    y1 += margen;
    const X = (d) => L + ((diaNum(d) - x0) / Math.max(1, x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const ticks = [y0 + margen, (y0 + y1) / 2, y1 - margen];
    const rejilla = ticks
      .map((v) => `<line class="g-rejilla" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="g-eje" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${eur(v)}</text>`)
      .join('');
    const fechas = todos.map((p) => p.x).sort();
    const ejeX = `<text class="g-eje" x="${L}" y="${H - 6}">${etiquetaDia(fechas[0])}</text><text class="g-eje" x="${W - R}" y="${H - 6}" text-anchor="end">${etiquetaDia(fechas[fechas.length - 1])}</text>`;

    const trazos = validas
      .map((s, i) => {
        const pts = s.puntos.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
        const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
        let area = '';
        if (i === 0) {
          area = `<path class="g-area ${s.clase}" d="${d}L${X(pts[pts.length - 1].x).toFixed(1)},${H - B}L${X(pts[0].x).toFixed(1)},${H - B}Z"/>`;
        }
        let fin = '';
        if (i === 0) {
          const u = pts[pts.length - 1];
          const cx = X(u.x), cy = Y(u.y);
          fin = `<circle class="g-punto ${s.clase}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>`;
        }
        return `${area}<path class="g-linea ${s.clase}${i ? ' g-secundaria' : ''}" d="${d}"/>${fin}`;
      })
      .join('');

    const leyenda = validas.length > 1
      ? `<div class="g-leyenda">${validas.map((s) => `<span><i class="${s.clase}"></i>${esc(s.nombre)}</span>`).join('')}</div>`
      : '';

    // Zonas invisibles para mostrar el valor al pasar el dedo/ratón
    const principal = validas[0].puntos.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
    const paso = principal.length > 1 ? (W - L - R) / (principal.length - 1) : W;
    const zonas = principal
      .map((p) => `<rect class="g-zona" x="${(X(p.x) - paso / 2).toFixed(1)}" y="${T}" width="${paso.toFixed(1)}" height="${H - T - B}"><title>${etiquetaDia(p.x)}: ${eur(p.y)} €/l</title></rect>`)
      .join('');

    return `<figure class="grafica">${titulo ? `<figcaption>${esc(titulo)}</figcaption>` : ''}
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo || 'Evolución del precio')}">${rejilla}${ejeX}${trazos}${zonas}</svg>${leyenda}</figure>`;
  }

  window.Graficas = { linea, etiquetaDia };
})();
