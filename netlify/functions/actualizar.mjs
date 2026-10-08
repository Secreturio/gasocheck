// Netlify Scheduled Function: cada 30 minutos descarga los precios del Ministerio, guarda el historial,
// envía las alertas de precio y calidad, limpia sesiones caducadas y hace la copia de seguridad diaria.
// Se puede lanzar a mano en Netlify → Functions → actualizar → «Run now».

import { crearApp } from '../../server/app.js';
import { crearAlmacen } from '../../server/almacen.js';

export default async () => {
  const almacen = await crearAlmacen({ netlify: true });
  const app = await crearApp({ almacen, demo: process.env.DEMO === '1', appUrl: process.env.APP_URL || process.env.URL || '' });
  try {
    // Límite de Netlify para funciones programadas: 30 s. Se deja margen para guardar.
    await app.actualizar({ tiempoMax: 20_000 });
  } catch (e) {
    console.error('Actualización fallida (se reintentará en la próxima):', e.message);
  }
};

export const config = {
  schedule: '*/30 * * * *',
};
