// Comprobación en el servidor de los datos leídos de un ticket.
// La foto se lee en el propio dispositivo (no se sube): aquí llegan los datos extraídos y una huella SHA-256
// de la imagen, que impide usar el mismo ticket en dos reseñas.

const DIA = 24 * 3600 * 1000;
const hoyMadrid = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

/** Devuelve { ticket } con los datos limpios, o { error } */
export function validarTicket(t, precioReferencia) {
  if (!t || typeof t !== 'object') return { error: 'Faltan los datos del ticket.' };
  const hash = String(t.hash || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return { error: 'La foto del ticket no es válida.' };
  if (t.coincideGasolinera !== true) return { error: 'El ticket no parece de esta gasolinera.' };
  const fecha = String(t.fecha || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'No se pudo leer la fecha del ticket.' };
  const hoy = hoyMadrid();
  const hace7 = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() - 7 * DIA));
  if (fecha > hoy || fecha < hace7) return { error: 'El ticket debe ser de los últimos 7 días.' };
  const litros = Number(t.litros);
  const importe = Number(t.importe);
  if (!(litros >= 1 && litros <= 200)) return { error: 'No se pudieron leer bien los litros del ticket.' };
  if (!(importe >= 1 && importe <= 1000)) return { error: 'No se pudo leer bien el importe del ticket.' };
  const pl = importe / litros;
  if (precioReferencia && Math.abs(pl - precioReferencia) / precioReferencia > 0.25) {
    return { error: 'El precio por litro del ticket no encaja con el de esta gasolinera.' };
  }
  return { ticket: { hash, fecha, litros: Math.round(litros * 100) / 100, importe: Math.round(importe * 100) / 100 } };
}
