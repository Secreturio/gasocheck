# GasoCheck

<img src="public/img/logo.png" alt="Logo de GasoCheck" width="96">

Mapa interactivo con **todas las gasolineras de España**, precios de gasóleo y gasolina actualizados desde la fuente oficial del Ministerio para la Transición Ecológica, buscador por ciudad / provincia / código postal / marca, y un **sistema de valoraciones de la calidad del combustible**.

Esta es la **versión web** (fase 1). Está pensada para reutilizarse tal cual en Android, iOS y Windows (ver hoja de ruta).

## Publicar en Netlify (recomendado)

GasoCheck está preparado para Netlify: la web se sirve como estática, la API funciona como **Netlify Function** y los datos (cuentas, valoraciones, historial de precios, fotos) se guardan en **Netlify Blobs**. No hace falta contratar base de datos ni servidor.

### Opción A — Desde GitHub (la más sencilla y la que se actualiza sola)

1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. En [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project** → elige el repositorio.
3. No toques nada de la configuración de compilación: Netlify la lee de `netlify.toml`. Pulsa **Deploy**.
4. (Recomendado) En **Project configuration → Environment variables** añade las variables de abajo y vuelve a desplegar (**Deploys → Trigger deploy**).

### Opción B — Con la terminal (Netlify CLI)

```bash
npm install
npx netlify-cli login
npx netlify-cli deploy --build --prod
```

> ⚠️ **No uses «arrastrar y soltar» la carpeta en Netlify Drop**: así solo se publica la web estática, sin la API, y no cargarían los precios ni las cuentas.

### Variables de entorno (Netlify → Project configuration → Environment variables)

| Variable | ¿Obligatoria? | Para qué |
|---|---|---|
| `ADMIN_TOKEN` | Recomendada | Clave larga para entrar en `/admin.html` (moderación). Sin ella, la moderación está desactivada. |
| `REPORT_SALT` | Recomendada | Cualquier cadena secreta: se usa para anonimizar las IPs de las valoraciones. |
| `RESEND_API_KEY` y `CORREO_REMITENTE` | Para enviar correos | Verificar la cuenta y recuperar la contraseña (p. ej. `GasoCheck <hola@gasocheck.es>`). Sin ellas, los correos se escriben en el registro de la función (**Logs → Functions → api**). |
| `APP_URL` | Opcional | Dirección pública para los enlaces de los correos. Si no la pones se usa la de Netlify (o tu dominio principal). |
| `VAPID_PUBLICA` y `VAPID_PRIVADA` | Opcional | Claves de notificaciones push. Si no las pones se generan solas y se guardan en Blobs. |
| `PUSH_CONTACTO` | Opcional | `mailto:` de contacto para los servicios push. |
| `REPORTES_SOLO_REGISTRADOS=1` | Opcional | Solo se puede valorar con cuenta y correo confirmado. |
| `DEMO=1` | Opcional | Usa las 72 gasolineras inventadas en vez de los precios reales. |

### Qué pasa al publicar

- **Precios:** la función `actualizar` descarga el listado del Ministerio **cada 30 minutos** (aparece en **Functions** con la etiqueta *Scheduled*; puedes lanzarla a mano con **Run now**). La primera visita, si todavía no ha corrido, los descarga en el momento (tarda unos segundos solo esa vez). Si el Ministerio tarda demasiado, la siguiente visita los actualiza en segundo plano.
- **Comprobar que todo va bien:** abre `https://TU-WEB.netlify.app/api/estado`. Debe mostrar unas 12.000 gasolineras y la fecha de los precios.
- **Actualizar precios ahora:** `curl -X POST -H "Authorization: Bearer TU_ADMIN_TOKEN" https://TU-WEB.netlify.app/api/admin/actualizar`
- **Móvil:** es una PWA. En Android/Chrome aparece «Instalar aplicación»; en iPhone, Compartir → «Añadir a pantalla de inicio» (necesario para las notificaciones en iOS). Netlify sirve todo con HTTPS, que es lo que exigen la geolocalización, el modo sin conexión y las notificaciones.
- **Copias de seguridad:** una al día de la base de datos, en Blobs (`copias/`), se guardan las 14 últimas. Puedes verlas en **Netlify → Blobs** (store `gasocheck`).

### Límites a tener en cuenta

- La base de datos es un fichero SQLite que se guarda entero en Blobs tras cada cambio, con escritura condicional (si dos peticiones escriben a la vez, una se repite: nunca se pierden datos). Va de sobra para miles de usuarios; si GasoCheck crece mucho (decenas de miles de cuentas activas), conviene pasar a PostgreSQL (el SQL está aislado en `cuentas.js`, `reportes.js`, `proveedores.js`, `avisos.js` y `flotas.js`).
- El límite de intentos de contraseña se cuenta por cada copia de la función, así que es algo menos estricto que en un servidor único.

## Arrancar en tu ordenador

Solo necesitas [Node.js 22.12 o superior](https://nodejs.org).

```bash
cd gasocheck
npm install        # solo hace falta para publicar en Netlify; en local no se usa
npm start          # datos reales del Ministerio  → http://localhost:3000
npm run demo       # 72 gasolineras inventadas, para probar sin conexión
```

En local los datos se guardan en `data/almacen/` (o `data/almacen-demo/`), con la misma estructura que en Netlify Blobs.

## Qué hace

- **Mapa** con las gasolineras agrupadas; cada marcador muestra el precio del combustible elegido, en verde/ámbar/rojo según sea barato o caro *dentro de la búsqueda actual*.
- **Buscador** con sugerencias de municipios y provincias; Intro hace búsqueda libre (marca, calle, código postal).
- **Combustibles:** Gasóleo A, Gasolina 95, Gasolina 98 y Gasóleo Premium (también se muestra GLP en la ficha).
- **Filtros:** abierta 24 h, calidad ≥ 7. **Orden:** precio, calidad o distancia (“cerca de mí”).
- **Ficha** de cada gasolinera: tótem de precios, horario, botón “Cómo llegar”.
- **Reportes de calidad:** 1–5 estrellas, combustible repostado, problemas (tirones, más consumo, agua, surtidor que no sirve lo que marca…) y comentario.
  - Puntuación de 0 a 10 con suavizado bayesiano (una sola opinión no hunde ni dispara la nota).
  - Solo cuentan los últimos 12 meses.
  - Límite de 1 valoración por gasolinera y persona al día, y 10 al día en total.
- **Alertas de calidad:** si 3 personas distintas reportan el mismo problema (o notas muy bajas) en 7 días, la gasolinera se marca en rojo en el mapa, la lista y la ficha. Filtro para ocultarlas.
- **Denuncias y moderación:** cualquier valoración se puede denunciar; con 3 denuncias se oculta hasta revisarla en `/admin.html`.
- **Historial de precios:** el servidor guarda un precio al día de cada gasolinera (90 días). La ficha muestra la gráfica frente a la media de la provincia; la lista indica cuánto ha subido o bajado en 7 días y se puede ordenar por “más bajada”.
- **Calculadora de ahorro:** cuánto cuesta llenar, cuánto ahorras frente a la media de la zona (10 km) y si compensa el desplazamiento desde tu ubicación.
- **Favoritas** guardadas en el dispositivo, con su propia pestaña.
- **Editar y eliminar tus valoraciones** desde la ficha o desde “Mis valoraciones” en tu perfil. Las editadas se marcan como “editada”. Sin cuenta, solo se pueden editar desde la misma conexión.
- **Ver u ocultar la contraseña** con el icono del ojo en todos los formularios (`public/ojo.js`).
- **Abierta ahora:** interpreta el horario oficial (tramos partidos, 24 h, horarios que cruzan la medianoche y hora de Canarias). Filtro, etiqueta “Abierta/Cerrada” en la lista y en la ficha “Abierta hasta las 22:00” o “Cerrada · abre mañana a las 07:00”. Si un horario no se entiende, la gasolinera no se oculta.
- **Mis descuentos (opcional):** añades los descuentos de tus tarjetas o apps por marca (céntimos por litro o %) o para todas las gasolineras. Un interruptor **Oficial / Con mis descuentos** cambia toda la app: precios, colores, orden, mapa y calculadora. En cada vista se ve también el otro precio (“tú 1,479” u “oficial 1,529”) y la ficha muestra ambos. Las estadísticas usan siempre el precio oficial.
- **Mi coche y diario de repostajes:** apuntas fecha, gasolinera, litros, importe, kilómetros y si llenaste el depósito (también desde la ficha, con el importe calculado solo). Calcula tu consumo real (método lleno a lleno), gasto por mes y precio medio pagado, y exporta a Excel (CSV). Si con el combustible de una gasolinera tu consumo sube un 12 % o más respecto a tu habitual, te avisa y te propone valorarla.
- **Estadísticas:** evolución del precio medio (España o provincia), ranking de provincias y de marcas, alertas activas y mejor valoradas.
- **Filtro por marca**, botón **Compartir** y enlaces directos a cada gasolinera (`/#e<id>`).
- **Modo sin conexión:** como app instalada, guarda los últimos precios y funciona sin cobertura.

## Novedades de la versión 1.8

- **Editor de fotos de perfil** (`public/editor-imagen.js`): al subir una foto se abre un editor con **zoom** (slider, +/−, rueda del ratón y pellizco en el móvil), **encuadre** arrastrando, **giro** de 90° y **giro fino** (±45°), **espejo**, **brillo y contraste** y **Restablecer**. La vista previa marca el círculo que se verá en el avatar. En el móvil ocupa toda la pantalla. «Ajustar encuadre» reabre la foto actual. Es reutilizable: `EditorImagen.abrir(fichero, { titulo, salida })` devuelve un JPEG cuadrado (o `null` si se cancela).
- **Foto de perfil sincronizada entre dispositivos**: cada foto nueva se guarda con su propio identificador (`perfil-<versión>`) y la versión viaja en los ajustes de la cuenta; antes todas usaban el mismo identificador y los demás dispositivos seguían enseñando su copia en caché. Además la app trae los cambios de la cuenta al volver a primer plano, al recuperar la conexión y cada minuto, y repinta el avatar al instante. Las fotos antiguas (`perfil-foto`) siguen funcionando.
- **Móvil, buscador con el teclado abierto**: mientras se escribe, el panel se ajusta al área realmente visible (`visualViewport`), se ocultan la cabecera y las pestañas, y el teclado se cierra al elegir un lugar o buscar (también al desplazar la lista). Se acabó la interfaz descuadrada.
- **Móvil, ficha de gasolinera plegable**: el botón «Ver en el mapa» pliega la ficha a una tarjeta compacta (nombre, estado y precio) y centra la gasolinera en la parte visible del mapa; «Ver detalles» la vuelve a abrir. Si arrastras el mapa, la ficha se pliega sola y, al tocar otra gasolinera, se mantiene plegada.

## Novedades de la versión 1.7

- **Ficha de gasolinera nueva**: cabecera con imagen, estado (abierta/cerrada), botones Cómo llegar · Guardar · Compartir · Apuntar repostaje · Avisarme si baja; *Precios por litro* en filas (pulsar una cambia de combustible), *Información del establecimiento*, *Calculadora de ahorro* con «Te ahorras … vs. precio medio de la zona» y *Tu experiencia*. La imagen de la cabecera (`img/gasolinera.jpg`) es genérica: no hay fotos reales de cada gasolinera.
- **Mapa**: marcadores con icono de surtidor de color; la gasolinera abierta, con chincheta azul y recuadro con nombre y precio. Ubicación arriba y + / − debajo.
- **Barra de menús** con el estilo del diseño y **Estadísticas** como pestaña tras Mi coche (también en el móvil).
- **Crear cuenta** con campo **Nombre** (si se deja vacío, se pone uno automático). Si la contraseña falla, el aviso es breve y las pestañas Entrar/Crear siguen a la vista.
- **Foto de perfil** (Mi cuenta → Datos personales): se recorta en cuadrado, sale en el avatar y se sincroniza con la cuenta (privada).
- **Foto del coche**: solo una foto de ese modelo y ese año (o uno de diferencia) en Wikimedia Commons, de frente o de lado; nunca traseras. Si no la hay, no se pone ninguna. Sin año, no se busca.
- **Aviso de cookies** la primera vez que se abre la web (informativo: GasoCheck no usa cookies de publicidad ni de análisis).

## Novedades de la versión 1.6

- **Favoritas, coches, descuentos y repostajes solo con cuenta.** Sin sesión, esas secciones invitan a entrar o crear una cuenta, y «Guardar» o «Apuntar repostaje» abren la pantalla de entrar. Si al abrir la app no hay sesión, se borran del dispositivo los datos personales que hubieran quedado (siguen en la cuenta). También al caducar la sesión.
- **Entrar / Crear cuenta**: la tarjeta mide siempre lo mismo y cabe en la pantalla; el formulario de crear cuenta se compacta (también en portátiles de 768 px de alto).
- **Mis repostajes**: quitada la barra de desplazamiento horizontal del formulario fijo (la causaba el campo oculto de la foto del ticket).
- **Entrar**: si la contraseña no es correcta, se vacía el campo y se avisa de que el navegador puede haber rellenado una antigua.

## Novedades de la versión 1.5: rediseño móvil y pantallas de acceso

- **Móvil**: cabecera con lupa y botón «Entrar»; buscador sobre el mapa con «cerca de mí» dentro; controles sueltos (leyenda/capas, zoom y ubicación); grupos con anillo verde cuando la zona es barata; hoja inferior con combustibles, buscador y «Cerca de mí / Radio»; pestañas con icono relleno y raya azul en la activa.
- **Favoritos**: si no hay ninguna, ilustración, texto y botón «Explorar gasolineras» (también en el ordenador). En el móvil, Favoritos ocupa toda la pantalla.
- **Entrar y Crear cuenta**: tarjeta con imagen a la izquierda y formulario a la derecha (en el móvil, la imagen arriba). Campos con iconos, ver/ocultar contraseña, repetir contraseña, contraseña con letras y números, y enlaces a «Tengo una gasolinera» y «Soy una empresa con vehículos».
- Al crear una cuenta personal, el nombre público se pone solo («Conductor 1234») y se cambia en *Mi cuenta → Datos personales*.
- Las imágenes `img/acceso.jpg`, `img/acceso-movil.jpg` y `img/favoritos-vacio.jpg` salen de los diseños; se pueden cambiar por versiones en más resolución con el mismo nombre.

## Novedades de la versión 1.4

- **Mis repostajes en dos columnas** (ordenador): el formulario para apuntar, fijo a la izquierda; a la derecha el selector de coches, los totales y la lista. Filtrar por coche no borra lo que estés escribiendo y pone ese coche en el formulario. En el móvil, el formulario sigue arriba y plegable.
- **Foto del coche de tu año**: con el año indicado, primero se busca en Wikimedia Commons una foto de ese modelo y ese año (de frente; se descartan interiores, detalles y traseras). Si no la hay, se usa la foto del artículo de Wikipedia, que suele ser la generación más reciente.

## Novedades de la versión 1.3: varios coches

- **Varios coches**: cada uno con su foto, bastidor, combustible y mediciones de consumo. Se elige pulsando su foto (en *Mi coche* y en el perfil). El coche elegido es el de la calculadora de ahorro.
- **Mi coche por apartados**: Datos del coche, Consumo, Gastos, Descuentos y Empresa.
- **Repostajes por coche**: al apuntar uno se elige el coche (si solo tienes uno, va a ese). En *Mis repostajes*, pulsando la foto de un coche se ven solo los suyos; pulsando otra vez, los de todos. Los repostajes anteriores se asignan al primer coche.
- **La foto cambia al cambiar el modelo**, sin esperar a guardar. La búsqueda en Wikipedia exige ahora todas las palabras del modelo («Serie 1» ya no da la foto del «Serie 3»).
- **Datos separados por cuenta**: al cerrar sesión se borran del dispositivo (siguen en la cuenta) y una cuenta nueva empieza vacía.
- **Buscador sobre el mapa**: se puede escribir una ciudad, código postal o marca; vacío, busca en la zona que se ve.
- Arreglos: cambiar de sección con la ficha de una gasolinera abierta; la calculadora de la ficha ya no borra el resto de ajustes; la sincronización no repinta (ni borra lo que escribes) si no ha cambiado nada.

## Novedades de la versión 1.2: perfil por apartados y foto del coche

- **Mi cuenta a pantalla completa** (como Mis repostajes y Mi coche), dividida en apartados: Resumen, Mi coche, Mis valoraciones, Datos personales, Seguridad y acceso, y Privacidad y datos.
- **Recuperar la cuenta por correo**: «¿Has olvidado la contraseña? Recupera tu cuenta» al entrar (y se ofrece solo si la contraseña falla). El enlace dura 1 hora; al usarlo eliges contraseña nueva y **entras directamente**, cerrando las demás sesiones. También se puede pedir desde *Seguridad y acceso*. Hasta que configures Resend, el correo sale en el registro de la función (Netlify) o en la consola (local).
- **Foto del coche**: con la marca, el modelo y el año, el servidor busca una foto orientativa del modelo en Wikipedia / Wikimedia Commons (gratis, sin clave), la guarda en el almacén (`coches/`) y la app muestra autor y licencia, como exige Commons. El usuario puede usar **su propia foto** en su lugar.
- **Número de bastidor (VIN)** opcional: se lee en el dispositivo y rellena la marca y el año (el modelo no viene en el bastidor).

## Novedades de la versión 1.0: nuevo diseño

- **Cabecera superior** con el logo, el menú (Mapa, Favoritos, Mis repostajes, Mi coche), la lupa, la campana de avisos y el avatar con iniciales. Las **estadísticas de precios** se abren desde el menú del avatar. En el móvil, el menú pasa a una barra inferior.
- **Panel de búsqueda**: combustibles (Gasolina 95, Gasolina 98, Diésel, Gasoil+), buscador, *Cerca de mí* con **radio** (5–100 km), filtros rápidos (*Abiertas ahora*, *24h*, *Autolavado*, *Tienda*) y *Ordenar por* Precio, Distancia o Confianza. El botón de ajustes guarda el resto (calidad, alertas, marca, mayor bajada y ruta).
- **Tarjetas** con distintivo de marca, sello de verificada, horario («Abierta • Cierra 22:00»), distancia, servicios y nota de calidad.
- **Mapa**: «Buscar en esta zona», controles de zoom y ubicación, marcadores en píldora con el color del precio, grupos con anillo azul, leyenda inferior y escala.
- Los servicios (tienda, lavado, cafetería, AdBlue) solo se conocen de las **gasolineras verificadas** que los indican en su ficha; el Ministerio no los publica.
- **Leaflet va incluido** en `public/vendor/` (ya no depende de unpkg).

## Novedades de la versión 0.9: Mi coche en tu perfil y modo gratuito

**Publicación como particular:** textos legales para una persona física con un proyecto gratuito y sin ánimo de lucro, y todas las funciones Pro gratis (ver *Pendiente antes de lanzar*).

### Mi coche

En **Mi cuenta → Mi coche** (también desde la pestaña *Mi coche*, enlace «Editar en mi perfil»):

- **Tu coche**: marca, modelo, año (desde 1980), combustible y capacidad del depósito (opcional). Si cambias el combustible, la app pasa a mostrar ese precio.
- **Calcular consumo**: metes los litros que echaste y los km que has hecho y se calcula al momento con la fórmula **litros ÷ km × 100** (l/100 km). Ej.: 45 l en 700 km → 6,43 l/100 km.
- Cada medición se guarda (las 100 últimas) y se muestra el **consumo medio** = total de litros ÷ total de km × 100, para que un viaje largo pese más que uno corto. Puedes borrar mediciones.
- Todo se sincroniza con tu cuenta y el consumo medio alimenta la calculadora de ahorro.

## Novedades de la versión 0.8: Mis repostajes

Pestaña nueva, **Repostajes**:
- Todos tus repostajes **agrupados por año, mes y día**.
- En cada año y cada mes, el total de repostajes, litros y euros (y el precio medio por litro del mes).
- En cada repostaje: fecha, gasolinera, litros, euros, €/l, combustible, kilómetros y la **foto del ticket**, que se amplía al tocarla.
- Para apuntar uno, añade la foto del ticket y la app rellena la fecha, los litros y el importe leyéndolo. También se puede añadir o cambiar la foto de un repostaje ya apuntado.
- Las fotos se reducen a ~200 KB y se guardan en el dispositivo y, con cuenta, en ella de forma privada (`PUT|GET|DELETE /api/cuenta/fotos/:id`, solo con la sesión de su dueño). Se borran con el repostaje o con la cuenta.
- Al valorar una gasolinera con ticket, se ofrece apuntarlo en Mis repostajes con su foto.
- **Mi coche** se queda con descuentos, datos del coche, resumen de consumo y gasto y la empresa.

## Novedades de la versión 0.7

- **Web adaptada a móvil:** el mapa ocupa toda la pantalla y la lista va en un panel inferior que se arrastra (abajo, a media altura o completo), como en las apps de mapas. Las pestañas pasan a una barra inferior con iconos, los botones miden al menos 44 px, los filtros se deslizan en horizontal y los campos de texto no hacen zoom en iPhone. Al mover el mapa, el panel se aparta solo.
- **Reputación de usuarios:** cada cuenta tiene una fiabilidad entre 0,2 y 2.
  - Parte de 1 con el correo confirmado (0,6 sin confirmar) y sube con la antigüedad, las reseñas con ticket y las correcciones de precio que se confirman.
  - Baja con contenido retirado y con correcciones contradichas.
  - La nota, las alertas de calidad y el consenso de precios suman fiabilidad en vez de contar personas: hacen falta 3 usuarios normales, o 2 muy fiables, y sin cuenta una opinión cuenta la mitad.
  - Insignia “Conductor fiable” y medidor en el perfil.
- **Reseña con foto del ticket:** el ticket se lee en el móvil con OCR (Tesseract), sin subir la foto. Se extraen la fecha, los litros, el importe, el precio, el CIF y el código postal, y se comprueba que es de esa gasolinera y de los últimos 7 días.
  - Cada ticket solo vale una vez (huella SHA-256).
  - La reseña se marca como “Ticket comprobado”, pesa ×1,5 y se ofrece apuntar el repostaje en el diario.
- **Avisos:** campana con bandeja, alertas de precio (“avísame si baja de 1,399 €”), aviso si una favorita tiene una alerta de calidad, y mensajes de gasolineras Pro.
  - Llegan también como **notificación push**. Web Push está implementado en Node sin dependencias y comprobado con el ejemplo oficial del RFC 8291. Funciona en Android, en escritorio y en iPhone si la app está añadida a la pantalla de inicio.
- **Ruta más barata:** origen y destino (o tu ubicación) y desvío máximo. Calcula la ruta por carretera con OSRM y ordena las gasolineras por coste total: el repostaje más el combustible del desvío.
- **¿Lleno ahora o espero?:** un consejo según la tendencia de la última semana y el día de la semana que suele ser más barato en tu provincia.
- **GasoCheck Pro para gasolineras** (lo activa el administrador):
  - precio frente a la competencia a menos de 5 km, evolución de la nota y visitas diarias;
  - un mensaje por semana a quienes la tienen en favoritas.
  - **No cambia la nota ni el orden en el mapa.**
- **GasoCheck Empresas** (`/empresa.html`):
  - un nuevo tipo de cuenta de empresa con vehículos y un código para que se unan sus conductores;
  - el conductor marca un repostaje como “de empresa” en su diario y llega al panel;
  - el panel muestra gasto, litros, consumo por vehículo y repostajes sospechosos: más litros que el depósito, combustible distinto, dos en menos de 4 h, kilómetros que bajan, precio un 8 % sobre el oficial y fuera de horario;
  - exporta a Excel. Gratis hasta 5 vehículos; ilimitados con Pro.
- **Accesos directos** al mantener pulsado el icono de la app: Cerca de mí, Ruta, Mi coche y Avisos.
- **Widget, Android Auto y CarPlay:** el servidor ya ofrece `/api/cercanas`. El código nativo se hace al empaquetar la app (ver `docs/app-nativa.md`).

## Base de datos

Cuentas, sesiones, datos sincronizados, valoraciones, denuncias, gasolineras verificadas, fichas, visitas y precios declarados se guardan en **SQLite** (con [sql.js](https://github.com/sql-js/sql.js), SQLite compilado a WebAssembly e incluido en `server/vendor/`, licencia MIT). El fichero vive en el almacén: Netlify Blobs en producción y `data/almacen/` en local.
- **Transacciones** y **claves foráneas**: al borrar una cuenta se borran en cascada sus sesiones y datos, y sus valoraciones quedan anónimas. Si algo falla a mitad, no se borra nada.
- **Esquema versionado** (`server/db.js`): los cambios futuros se aplican solos al arrancar.
- **Escritura condicional por ETag**: cada petición comprueba si hay una versión más nueva antes de leer, y solo guarda si nadie la ha cambiado entretanto; si no, repite la petición.
- **Copias de seguridad diarias** en `copias/` del almacén. Se guardan las 14 últimas.
- El historial de precios oficiales se queda en `historico/` del almacén (una foto diaria completa y otra partida en 64 trozos para que la gráfica de una gasolinera cargue rápido).

## Cuentas

**Personas:** registro con nombre público, correo y contraseña. Con la cuenta, favoritas, descuentos, diario y ajustes se sincronizan entre dispositivos (si borras algo en el móvil, también desaparece en el ordenador; si un dispositivo edita y otro borra a la vez, gana la edición). Las valoraciones salen con su nombre y una ✓ si confirmó el correo. Se puede seguir valorando sin cuenta, salvo que actives `REPORTES_SOLO_REGISTRADOS=1`.

**Gasolineras:** registro con razón social, CIF/NIF y teléfono. Tras confirmar el correo, reclaman sus gasolineras en `/proveedor.html` explicando cómo comprobarlo. **Un administrador revisa cada reclamación a mano** en `/admin.html` (aprobar, rechazar o revocar), porque cualquiera podría decir que una gasolinera es suya. Una vez aprobada, la gasolinera:
- aparece como **verificada** (✓) en la lista y en la ficha;
- añade servicios, teléfono, web, descripción y una **promoción** de hasta 3 meses (etiqueta “Promo” en la lista);
- **responde públicamente** a las valoraciones;
- ve su nota, sus alertas y las **visitas a su ficha** de los últimos 30 días.
- **publica sus propios precios**, también de combustibles que el Ministerio no tiene. Se muestran **junto al oficial, nunca en su lugar**, con la hora de publicación: en la ficha (“La gasolinera declara 1,449 € · hace 2 h”) y en la lista (“Gasolinera: 1,449”). Si el Ministerio no tiene ese combustible, se usa el declarado, marcado como “declarado”.
  - Para evitar errores, no se acepta un precio que se aleje más de un **25 %** del oficial.
  - Los precios no caducan: se muestran siempre con la hora en que se publicaron.
  - **Corrección por los usuarios:** si un cliente ve otro precio en el surtidor, lo indica desde la ficha o al valorar. Solo cuentan cuentas personales con el correo confirmado, una indicación por persona y combustible. Cuando **3 usuarios distintos coinciden** (±1 céntimo) en las últimas 72 h, su precio pasa al hueco del de la gasolinera como “según 3 usuarios”. Si la gasolinera publica un precio nuevo, vuelve a mostrarse el suyo. La gasolinera ve en su panel las indicaciones pendientes.
  - Cada cambio queda en un **historial** junto con el precio oficial de ese momento, para resolver disputas.
  - Si se revoca la verificación, sus precios declarados se retiran.
  - Los usuarios pueden marcar al valorar “El precio no era el que anuncia la gasolinera”.

Una gasolinera no puede valorar gasolineras.

**Seguridad:**
- Contraseñas con scrypt y sal; nunca se guardan en claro.
- Sesiones con token aleatorio de 256 bits. En el servidor solo se guarda su huella SHA-256. Caducan a los 30 días sin uso.
- Enlaces de verificación (3 días) y de recuperación de contraseña (1 hora), de un solo uso.
- Recuperar o cambiar la contraseña cierra las demás sesiones.
- Bloqueo de 15 minutos tras 8 intentos fallidos por IP o por correo.
- Mensajes que no revelan qué correos están registrados.
- Se puede descargar los datos propios y borrar la cuenta. Al borrarla, las valoraciones quedan anónimas y las gasolineras quedan libres.

**Textos legales:** aviso legal (LSSI-CE), política de privacidad (RGPD y LOPDGDD), condiciones de uso y página de cookies y almacenamiento. La app no usa cookies; solo guarda en el dispositivo lo estrictamente necesario. Los datos del titular se rellenan **una sola vez en `public/legal.js`**. Mientras falte alguno, las páginas legales muestran un aviso en rojo. El registro incluye:
- la casilla de edad mínima de 14 años;
- la información básica de protección de datos junto al formulario;
- la versión de las condiciones aceptadas y su fecha, que se guardan como prueba del consentimiento.

**Correos:** con `RESEND_API_KEY` y `CORREO_REMITENTE` se envían de verdad con [Resend](https://resend.com). Sin ellas, se muestran en el registro de la función de Netlify (**Logs → Functions → api**) o en la consola en local; desde ahí puedes copiar los enlaces de verificación.

## Estructura

```
netlify.toml                    configuración de Netlify (publicación, funciones, cabeceras)
netlify/functions/api.mjs       función con toda la API (/api/*)
netlify/functions/actualizar.mjs función programada: precios, historial, avisos y copias cada 30 min
scripts/comprobar.mjs           comprobación previa al publicar (npm run build)
server/app.js          rutas de la API (Request → Response), común a Netlify y al servidor local
server/index.js        servidor local (npm start / npm run demo)
server/almacen.js      almacén de ficheros: Netlify Blobs o carpeta local
server/db.js           SQLite (sql.js): esquema, migraciones, transacciones, guardado condicional
server/estaciones.js   descarga y normaliza los datos del Ministerio
server/historico.js    foto diaria de precios (90 días)
server/cuentas.js      registro, acceso, sesiones, recuperación, sincronización, borrado
server/proveedores.js  reclamaciones de gasolineras, fichas ampliadas, visitas
server/correo.js       envío de correos (Resend o registro)
server/reputacion.js   fiabilidad de cada usuario
server/ticket.js       comprobación de tickets
server/avisos.js       alertas de precio y calidad, bandeja, mensajes de gasolineras Pro
server/webpush.js      notificaciones push (RFC 8291 + VAPID)
server/consejo.js      ¿lleno ahora o espero?
server/flotas.js       GasoCheck Empresas
server/fotos.js        fotos privadas de tickets y de perfil
server/fotocoche.js    foto orientativa del coche (Wikimedia Commons)
server/reportes.js     valoraciones, alertas, denuncias y moderación
server/vendor/         sql.js (SQLite en WebAssembly)
server/demo-estaciones.js  datos inventados para el modo demo
public/                la web (HTML + CSS + JS, sin compilación)
public/graficas.js     gráficas SVG sin librerías
public/horario.js      interpreta los horarios oficiales
public/micoche.js      descuentos y cálculos del diario
public/sw.js           modo sin conexión
public/cuenta.js       entrar, registro, perfil y sincronización
public/proveedor.html  panel de gasolinera (+ proveedor.js)
public/admin.html      moderación: reclamaciones y valoraciones
public/ruta.js         ruta más barata
public/ticket.js       lectura del ticket en el dispositivo
public/avisos.js       campana, alertas y notificaciones
public/fotos.js        fotos de tickets: dispositivo, cuenta y visor
public/empresa.html    panel de empresa (+ empresa.js)
docs/app-nativa.md     widget, Android Auto y CarPlay
public/img/             logo e iconos de la app (favicon, Android, iOS)
public/ojo.js          botón ver/ocultar contraseña
public/legal.js        DATOS DEL TITULAR (rellenar antes de publicar)
public/aviso-legal.html, privacidad.html, condiciones.html, almacenamiento.html  textos legales
public/config.js       URL de la API (para las apps móviles/escritorio)
```

### API

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/estaciones` | Todas las gasolineras y precios |
| GET | `/api/calidad` | Puntuación de calidad por gasolinera |
| GET | `/api/problemas` | Problemas que se pueden reportar |
| GET | `/api/estaciones/:id/reportes` | Resumen y últimas valoraciones |
| POST | `/api/estaciones/:id/reportes` | `{puntuacion, combustible, problemas[], comentario}` |
| PUT / DELETE | `/api/reportes/:rid` | Editar o eliminar tu valoración |
| POST | `/api/reportes/:rid/denuncia` | Denunciar una valoración |
| POST | `/api/estaciones/:id/precios/correccion` | Indicar el precio real (`{combustible, precio}`, con sesión) |
| GET | `/api/estaciones/:id/historico` | Precio diario de una gasolinera |
| GET | `/api/tendencia?provincia=X` | Precio medio diario (España si no se indica provincia) |
| GET | `/api/variaciones` | Subidas y bajadas de los últimos 7 días |
| GET | `/api/admin/reportes?filtro=` | Moderación (`denunciados`, `ocultos`, `todos`) |
| POST | `/api/admin/reportes/:rid` | `{accion: aprobar \| ocultar \| borrar}` |

Cuentas: `POST /api/auth/registro · entrar · salir · verificar · reenviar · olvido · restablecer`, `GET /api/auth/yo`, `POST /api/cuenta/password · perfil · borrar`, `GET|PUT /api/cuenta/datos`, `GET /api/cuenta/reportes` (mis valoraciones), `GET /api/cuenta/exportar`.
Avisos: `GET|POST /api/alertas`, `DELETE /api/alertas/:id`, `GET /api/avisos`, `POST /api/avisos/leidos`, `GET /api/push/clave`, `POST /api/push/suscribir|desuscribir`.
Otros: `GET /api/consejo?provincia=&combustible=`, `GET /api/cercanas?lat=&lng=&combustible=&n=&radio=`.
Empresas: `GET /api/empresa/panel?desde=&hasta=`, `POST|DELETE /api/empresa/vehiculos`, `POST /api/empresa/codigo`, `DELETE /api/empresa/conductores/:id`; conductor: `GET /api/flotas`, `POST /api/flotas/unirse`, `DELETE /api/flotas/:id`, `POST /api/flotas/repostajes`.
Pro: `GET /api/proveedor/estaciones/:id/estadisticas`, `POST /api/proveedor/estaciones/:id/mensaje`. Admin: `GET /api/admin/cuentas`, `POST /api/admin/cuentas/:id/plan`.
Gasolineras: `GET /api/proveedor/panel`, `POST|GET /api/proveedor/estaciones/:id/precios` (publicar precios / historial), `POST /api/proveedor/reclamaciones`, `POST /api/proveedor/estaciones/:id/ficha`, `POST /api/proveedor/reportes/:rid/respuesta`. Públicas: `GET /api/estaciones/:id/ficha`, `GET /api/extras`.
Administración: `GET /api/admin/reclamaciones?estado=`, `POST /api/admin/reclamaciones/:id {accion: aprobar | rechazar | revocar, nota}`.

Las rutas con sesión piden `Authorization: Bearer <token de sesión>`. Las rutas `/api/admin/*` piden la cabecera `Authorization: Bearer <ADMIN_TOKEN>`.

## Publicarla en otro sitio

Además de Netlify (arriba), funciona en cualquier hosting con Node 22 (Render, Railway, Fly.io, un VPS) con `npm start`; los datos se guardan entonces en `data/almacen/`, que necesita disco persistente. Variables adicionales en ese caso: `PORT` y `TRUST_PROXY=1` (solo detrás de un proxy, para leer la IP real).

- En `public/config.js`, `window.GASOCHECK_RUTAS` cambia el servidor de rutas. El público de OSRM es solo para pruebas; en producción conviene uno propio o un proveedor (OpenRouteService, Mapbox…).
- Otras rutas útiles: `GET /api/estado` (estado del servicio) y `POST /api/admin/actualizar` (descargar precios ya, con `ADMIN_TOKEN`).

## Hoja de ruta: Android, iOS y Windows

La web está hecha para ser el código común de todas las plataformas:

1. **Instalable ya (PWA):** en Chrome/Edge (Android y Windows) aparece “Instalar aplicación”. En iPhone: Compartir → “Añadir a pantalla de inicio”.
2. **Android e iOS en las tiendas — [Capacitor](https://capacitorjs.com):** envuelve la carpeta `public/` en apps nativas.
   ```bash
   npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/geolocation
   npx cap init GasoCheck es.gasocheck.app --web-dir=public
   npx cap add android && npx cap add ios
   npx cap open android     # Android Studio
   npx cap open ios         # Xcode (necesita un Mac)
   ```
   Antes, pon la URL pública del servidor en `public/config.js`.
3. **Windows — [Tauri](https://tauri.app)** (ligero, ~10 MB) apuntando a `public/`, o publicar la PWA en Microsoft Store con [PWABuilder](https://www.pwabuilder.com).

## Pendiente antes de lanzar

- **Anti-fraude:** cuentas de usuario o verificación (p. ej. foto del ticket), y moderación de comentarios. Una gasolinera podría inflar su nota o la competencia hundirla.
- **Entrar con Google o Apple** (casi obligatorio en iOS si se ofrece otro inicio de sesión social).
- **Verificación en dos pasos** para las cuentas de gasolinera.
- **Consumo anómalo colectivo:** ahora que hay cuentas, agregar de forma anónima las subidas de consumo de muchos conductores por gasolinera como señal de calidad objetiva.
- **GasoCheck es gratis para todos.** Las funciones Pro (estadísticas y mensajes para gasolineras, vehículos ilimitados para empresas) están abiertas a todas las cuentas. El código de planes de pago sigue ahí, apagado: se enciende con `GASOCHECK_PAGOS=1`. Antes de cobrar nada (planes, publicidad, donaciones habituales) revisa tu situación fiscal (alta como autónomo) y cambia el apartado 5 de las condiciones y el aviso legal.
- **Mapa base:** se usan los mosaicos gratuitos de OpenStreetMap (sin clave). Su política de uso los permite para tráfico moderado; si GasoCheck crece mucho, pasa a un proveedor con plan gratuito y clave (p. ej. MapTiler) definiendo `window.GASOCHECK_TESELAS` en `index.html` (ver comentario en `app.js`).
- **Texto legal:** rellena `public/legal.js`. Está preparado para publicarla **como particular, sin empresa ni alta de autónomo**: solo son obligatorios tu nombre, un correo de contacto y el alojamiento; el NIF y el domicilio son opcionales y no se muestran si los dejas vacíos. Es recomendable que un abogado revise los textos antes del lanzamiento, sobre todo las condiciones para gasolineras.
- **Aviso legal:** los precios son datos abiertos del Ministerio y su reutilización exige citar la fuente (ya se muestra en la cabecera). Las valoraciones son opiniones de usuarios: conviene unas condiciones de uso y un canal para que las gasolineras puedan responder.
