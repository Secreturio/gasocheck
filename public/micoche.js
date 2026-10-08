/* Lógica de "Mi coche": descuentos y diario de repostajes. Sin DOM, para poder probarla aparte. */
(() => {
  'use strict';
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  /* ---------- Descuentos ----------
     Regla: { id, marca: 'REPSOL' | '*' (todas), tipo: 'cent' (céntimos por litro) | 'pct', valor, nombre? } */
  function mejorDescuento(reglas, rotulo, precio) {
    if (!reglas || !reglas.length || precio == null) return null;
    const r = norm(rotulo);
    let mejor = null;
    for (const g of reglas) {
      const m = norm(g.marca);
      if (!(m === '*' || (m && r.includes(m)))) continue;
      const v = Number(g.valor);
      if (!Number.isFinite(v) || v <= 0) continue;
      let ahorro = g.tipo === 'pct' ? (precio * v) / 100 : v / 100;
      ahorro = Math.min(ahorro, precio * 0.5); // salvaguarda contra errores de tecleo
      if (!mejor || ahorro > mejor.ahorro) mejor = { ahorro, regla: g };
    }
    return mejor;
  }

  const textoRegla = (g) =>
    `${g.marca === '*' ? 'Todas las gasolineras' : g.marca}: ${String(g.valor).replace('.', ',')} ${g.tipo === 'pct' ? '%' : 'cént./l'}`;

  /* ---------- Diario de repostajes ----------
     Entrada: { id, fecha:'AAAA-MM-DD', estacion, nombre, combustible, litros, importe, km, lleno } */
  function analizarDiario(entradas) {
    const lista = (entradas || []).filter((e) => e.litros > 0);
    const litrosTotales = lista.reduce((a, e) => a + e.litros, 0);
    const importeTotal = lista.reduce((a, e) => a + (e.importe || 0), 0);
    const conImporte = lista.filter((e) => e.importe > 0);
    const litrosConImporte = conImporte.reduce((a, e) => a + e.litros, 0);

    const gastoPorMes = {};
    for (const e of lista) {
      const mes = (e.fecha || '').slice(0, 7);
      if (mes) gastoPorMes[mes] = (gastoPorMes[mes] || 0) + (e.importe || 0);
    }

    // Consumo real por el método "lleno a lleno":
    // entre dos llenados completos, el combustible gastado = litros echados después del primero (incluido el segundo).
    const conKm = lista.filter((e) => e.km > 0).sort((a, b) => a.km - b.km || (a.fecha < b.fecha ? -1 : 1));
    const tramos = [];
    let ultimoLleno = -1;
    for (let i = 0; i < conKm.length; i++) {
      if (!conKm[i].lleno) continue;
      if (ultimoLleno >= 0) {
        const a = conKm[ultimoLleno];
        const b = conKm[i];
        const km = b.km - a.km;
        let litros = 0;
        for (let j = ultimoLleno + 1; j <= i; j++) litros += conKm[j].litros;
        if (km >= 30 && litros > 0) {
          tramos.push({
            desde: a.fecha,
            hasta: b.fecha,
            km,
            litros,
            consumo: (litros / km) * 100,
            // El combustible quemado en el tramo es sobre todo el del llenado inicial
            estacion: a.estacion || null,
            nombre: a.nombre || '',
          });
        }
      }
      ultimoLleno = i;
    }
    const kmTramos = tramos.reduce((a, t) => a + t.km, 0);
    const litrosTramos = tramos.reduce((a, t) => a + t.litros, 0);
    const consumoMedio = kmTramos ? (litrosTramos / kmTramos) * 100 : null;
    // Cada tramo se compara con la mediana de los DEMÁS, para que un tramo malo no se tape a sí mismo
    const mediana = (xs) => {
      const s = xs.slice().sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    tramos.forEach((t, i) => {
      const otros = tramos.filter((_, j) => j !== i).map((x) => x.consumo);
      t.referencia = otros.length ? mediana(otros) : null;
      t.desviacion = t.referencia ? t.consumo / t.referencia - 1 : 0;
    });

    // Consumo anómalo: necesita al menos 3 tramos para tener una referencia fiable
    const UMBRAL = 0.12;
    const anomalias = tramos.length >= 3 ? tramos.filter((t) => t.desviacion >= UMBRAL && t.estacion) : [];

    return {
      repostajes: lista.length,
      litrosTotales,
      importeTotal,
      precioMedio: litrosConImporte ? conImporte.reduce((a, e) => a + e.importe, 0) / litrosConImporte : null,
      gastoPorMes,
      tramos,
      consumoMedio,
      anomalias,
    };
  }

  function csvDiario(entradas, nombresCombustible = {}) {
    const cab = ['fecha', 'gasolinera', 'combustible', 'litros', 'importe_eur', 'precio_litro', 'km', 'deposito_lleno'];
    const q = (v) => {
      const s = String(v ?? '');
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const dec = (n, d) => (n == null || n === '' ? '' : Number(n).toFixed(d).replace('.', ','));
    const filas = entradas
      .slice()
      .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
      .map((e) =>
        [
          e.fecha,
          e.nombre || '',
          nombresCombustible[e.combustible] || e.combustible || '',
          dec(e.litros, 2),
          dec(e.importe, 2),
          e.importe && e.litros ? dec(e.importe / e.litros, 3) : '',
          e.km || '',
          e.lleno ? 'sí' : 'no',
        ].map(q).join(';')
      );
    // Punto y coma y coma decimal: es lo que espera Excel en español
    return '﻿' + [cab.join(';'), ...filas].join('\r\n');
  }

  /* ---------- Consumo medio: litros ÷ km × 100 ---------- */
  // Consumo de una medición, en litros cada 100 km
  function consumo(litros, km) {
    const l = Number(litros), k = Number(km);
    if (!(l > 0) || !(k > 0)) return null;
    return Math.round((l / k) * 100 * 100) / 100;
  }
  // Media de varias mediciones: total de litros ÷ total de km × 100
  // (así un viaje largo pesa más que uno corto, que es lo correcto)
  function consumoMedio(mediciones) {
    const ms = (mediciones || []).filter((m) => m.litros > 0 && m.km > 0);
    if (!ms.length) return null;
    return consumo(ms.reduce((a, m) => a + m.litros, 0), ms.reduce((a, m) => a + m.km, 0));
  }

  /* ---------- Número de bastidor (VIN) ----------
     Se interpreta en el propio dispositivo, sin enviarlo a nadie.
     Las 3 primeras letras (WMI) dicen el fabricante. La posición 10 indica el año en los coches
     que lo codifican (obligatorio en EE. UU.; en Europa muchos fabricantes también lo hacen). */
  const WMI = {
    VSS: 'Seat', VSE: 'Seat', VS6: 'Ford', VS7: 'Citroën', VSK: 'Nissan', VSX: 'Opel', VS5: 'Renault',
    WVW: 'Volkswagen', WVG: 'Volkswagen', WV1: 'Volkswagen', WV2: 'Volkswagen', '3VW': 'Volkswagen',
    WAU: 'Audi', WUA: 'Audi', TRU: 'Audi', TMB: 'Skoda', WBA: 'BMW', WBS: 'BMW', WBY: 'BMW', WMW: 'Mini',
    WDD: 'Mercedes-Benz', WDB: 'Mercedes-Benz', WDC: 'Mercedes-Benz', WDF: 'Mercedes-Benz', W1K: 'Mercedes-Benz', W1N: 'Mercedes-Benz', W1V: 'Mercedes-Benz',
    WME: 'Smart', WP0: 'Porsche', WP1: 'Porsche', W0L: 'Opel', W0V: 'Opel', WF0: 'Ford', '1FA': 'Ford', '1FM': 'Ford',
    VF1: 'Renault', VF2: 'Renault', VF6: 'Renault', UU1: 'Dacia', VF3: 'Peugeot', VF7: 'Citroën', VR1: 'DS', VR3: 'Peugeot', VR7: 'Citroën',
    ZFA: 'Fiat', ZFF: 'Ferrari', ZAR: 'Alfa Romeo', ZCF: 'Iveco', ZAC: 'Jeep', '1C4': 'Jeep', '1J4': 'Jeep',
    SJN: 'Nissan', JN1: 'Nissan', JN8: 'Nissan', JMZ: 'Mazda', JM1: 'Mazda', JMB: 'Mitsubishi', MMB: 'Mitsubishi',
    JT2: 'Toyota', JTD: 'Toyota', JTE: 'Toyota', JTM: 'Toyota', JTN: 'Toyota', SB1: 'Toyota', VNK: 'Toyota', NMT: 'Toyota', JTH: 'Lexus',
    JHM: 'Honda', SHH: 'Honda', SHS: 'Honda', KMH: 'Hyundai', TMA: 'Hyundai', NLH: 'Hyundai', KNA: 'Kia', KND: 'Kia', U5Y: 'Kia', U6Y: 'Kia',
    JS2: 'Suzuki', JSA: 'Suzuki', TSM: 'Suzuki', JF1: 'Subaru', JF2: 'Subaru', YV1: 'Volvo', YV4: 'Volvo', LYV: 'Volvo',
    SAL: 'Land Rover', SAJ: 'Jaguar', SCC: 'Lotus', '5YJ': 'Tesla', '7SA': 'Tesla', LRW: 'Tesla', XP7: 'Tesla',
    LGX: 'BYD', LC0: 'BYD', LSJ: 'MG', SDP: 'MG', KPT: 'SsangYong', VXK: 'Opel', VXF: 'Fiat', LVS: 'Ford',
  };
  const CODIGOS_ANIO = 'ABCDEFGHJKLMNPRSTVWXY123456789'; // A = 1980 … Y = 2000, 1 = 2001 … 9 = 2009, y se repite cada 30 años
  function decodificarVin(vin, hoy = new Date()) {
    const v = String(vin || '').toUpperCase().replace(/[\s-]/g, '');
    if (!v) return { valido: false, error: 'Escribe el número de bastidor.' };
    if (v.length !== 17) return { valido: false, error: `El bastidor tiene 17 caracteres (has escrito ${v.length}).` };
    if (/[IOQ]/.test(v)) return { valido: false, error: 'El bastidor nunca lleva las letras I, O ni Q (seguramente es un 1 o un 0).' };
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return { valido: false, error: 'El bastidor solo lleva letras y números.' };
    const marca = WMI[v.slice(0, 3)] || null;
    let anio = null;
    const i = CODIGOS_ANIO.indexOf(v[9]);
    if (i >= 0) {
      const max = hoy.getFullYear() + 1;
      for (let a = 1980 + i; a <= max; a += 30) anio = a; // el más reciente posible
    }
    return { valido: true, vin: v, marca, anio, wmi: v.slice(0, 3) };
  }

  /* ---------- Varios coches ----------
     ajustes.coches = [{ id, marca, modelo, anio, combustible, deposito, vin, fotoPropia, fotoId, mediciones: [] }]
     ajustes.cocheActivo = id del coche elegido */
  function migrarAjustes(aj, nuevoId) {
    const a = { ...(aj || {}) };
    if (!Array.isArray(a.coches)) {
      a.coches = [];
      const viejo = a.coche;
      if (viejo && (viejo.marca || viejo.modelo)) {
        // Versión anterior: un solo coche y sus mediciones sueltas en los ajustes
        a.coches.push({ ...viejo, id: nuevoId(), mediciones: a.mediciones || [], fotoId: viejo.fotoPropia ? 'micoche-foto' : undefined });
      }
    }
    delete a.coche;
    delete a.mediciones;
    a.coches = a.coches.filter((c) => c && c.id).map((c) => ({ ...c, mediciones: Array.isArray(c.mediciones) ? c.mediciones : [] }));
    if (!a.coches.some((c) => c.id === a.cocheActivo)) a.cocheActivo = a.coches[0]?.id || null;
    return a;
  }
  // ¿Este repostaje es de este coche? Los apuntados antes de tener varios coches son del primero.
  function esDelCoche(entrada, cocheId, coches) {
    if (!cocheId) return true;
    if (entrada.coche && (coches || []).some((c) => c.id === entrada.coche)) return entrada.coche === cocheId;
    return (coches || [])[0]?.id === cocheId;
  }
  const nombreCoche = (c) => (c ? [c.marca, c.modelo].filter(Boolean).join(' ') || 'Coche sin nombre' : '');

  const api = { mejorDescuento, textoRegla, analizarDiario, csvDiario, consumo, consumoMedio, decodificarVin, migrarAjustes, esDelCoche, nombreCoche };
  if (typeof window !== 'undefined') window.MiCoche = api;
})();
