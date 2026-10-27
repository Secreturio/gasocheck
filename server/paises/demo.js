// Gasolineras inventadas de otros países para el modo de demostración (sin conexión)
import { NOMBRES_UE } from './comun.js';

const CENTROS = { fr: [48.8566, 2.3522, 'Paris', 'Île-de-France'], it: [41.9028, 12.4964, 'Roma', 'RM'], pt: [38.7223, -9.1393, 'Lisboa', 'Lisboa'], de: [52.52, 13.405, 'Berlin', 'Berlin'] };
const MARCAS = { fr: ['TotalEnergies', 'Intermarché', 'Leclerc', 'Carrefour', 'Esso'], it: ['Eni', 'Q8', 'IP', 'Tamoil', 'Esso'], pt: ['Galp', 'Repsol', 'BP', 'Prio', 'Cepsa'], de: ['Aral', 'Shell', 'Esso', 'JET', 'Total'] };

export function demoPais(p) {
  const [lat, lng, ciudad, prov] = CENTROS[p] || [50, 10, NOMBRES_UE[p], ''];
  const base = { fr: 1.78, it: 1.82, pt: 1.74, de: 1.75 }[p] || 1.8;
  return Array.from({ length: 30 }, (_, i) => {
    const a = (i * 137.5 * Math.PI) / 180, r = 0.01 + (i % 10) * 0.012;
    const d = ((i * 7) % 13) / 100;
    return {
      id: `${p}-demo${i + 1}`,
      rotulo: MARCAS[p]?.[i % 5] || 'Station',
      direccion: `${{ fr: 'Rue de la Démo', it: 'Via Demo', pt: 'Rua da Demo', de: 'Demostraße' }[p] || 'Demo'} ${i + 1}`,
      localidad: ciudad, municipio: ciudad, provincia: prov, cp: '', horario: '', venta: 'publico',
      lat: +(lat + r * Math.sin(a)).toFixed(5), lng: +(lng + r * Math.cos(a) * 1.4).toFixed(5),
      precios: { gasolina95: +(base + d).toFixed(3), gasolina98: +(base + 0.12 + d).toFixed(3), gasoleoA: +(base - 0.05 + d).toFixed(3), ...(i % 4 === 0 ? { glp: 0.99 } : {}) },
    };
  });
}
