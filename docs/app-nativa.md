# GasoCheck nativo: widget, Android Auto y CarPlay

Estas tres funciones necesitan código nativo dentro de la app de Android e iOS, así que se hacen al empaquetar la app con Capacitor (ver README). El servidor ya está preparado.

## Servicio que usan: `GET /api/cercanas`

Gasolineras más baratas cerca de un punto, en formato compacto.

```
GET /api/cercanas?lat=40.4168&lng=-3.7038&combustible=gasoleoA&n=5&radio=10
```

| Parámetro | Valor |
|---|---|
| `lat`, `lng` | Posición (obligatorios) |
| `combustible` | `gasoleoA`, `gasoleoPremium`, `gasolina95`, `gasolina98` o `glp` (por defecto `gasoleoA`) |
| `n` | Cuántas devolver, de 1 a 20 (por defecto 5) |
| `radio` | Kilómetros, de 1 a 50 (por defecto 10) |

Respuesta:

```json
{
  "combustible": "gasoleoA",
  "actualizado": "07/10/2026 16:30:00",
  "gasolineras": [
    { "id": "6230", "rotulo": "REPSOL", "direccion": "…", "localidad": "…", "lat": 41.8, "lng": -2.78, "precio": 1.429, "km": 1.2 }
  ]
}
```

Para abrir una gasolinera en la app: `https://gasocheck.es/#e<id>`.

## Widget de pantalla de inicio

- **Android:** un `AppWidgetProvider` en Kotlin dentro del proyecto `android/` de Capacitor. Usa `WorkManager` para pedir `/api/cercanas` cada 30–60 minutos con la última ubicación conocida y muestra las 3 más baratas. Al tocar, abre la app en `#e<id>`.
- **iPhone:** una extensión de widget con WidgetKit (SwiftUI) en el proyecto `ios/`. Usa un `TimelineProvider` que refresca cada 30 minutos. Para compartir la ubicación y el combustible elegido con la app, se usa un App Group.

## Android Auto

- Se usa la **Android for Cars App Library** con una app de categoría **puntos de interés o gasolineras**. Google revisa estas apps antes de publicarlas en Play.
- La pantalla es una `PlaceListMapTemplate` con las gasolineras de `/api/cercanas`. Al pulsar una, se abre la navegación del coche.
- Las plantillas del coche están limitadas a propósito para no distraer: solo lista, mapa y navegar.

## CarPlay

- Apple exige solicitar el permiso de CarPlay de la categoría **Fueling** (`com.apple.developer.carplay-fueling`) y que lo aprueben antes de publicar.
- Se usa `CPPointOfInterestTemplate` con las gasolineras de `/api/cercanas`.

## Orden recomendado

1. Publicar la web y la app de Android con Capacitor.
2. Widget de Android, que es lo más rápido.
3. Android Auto.
4. App de iOS, widget de iPhone y CarPlay, que necesitan un Mac, cuenta de desarrollador de Apple y la aprobación de CarPlay.
