PORTADA VANI & FEDE · v32200

Cambios incluidos:
- “La Convocatoria” fue reemplazado por “VANI & FEDE”.
- La tipografía replica el estilo de la invitación.
- La fecha 24 - 10 - 2026 tiene mayor tamaño y presencia.
- Nuevo mensaje más cálido e intrigante, sin anticipar los juegos ni los equipos.
- Se eliminó “Encontrá tu invitación”.
- El botón continúa llamándose “Ingresar”.
- El formulario quedó más compacto y minimalista.

Archivos para reemplazar:
1. index.html
2. styles.css
3. app.js (sin cambios funcionales; se incluye para mantener el paquete completo)
4. assets/branding/vyf-seal.png

No reemplazar:
- config.js
- data.js

Luego de publicar, abrir la web agregando ?v=32200 al final de la URL.


v32300:
- Se agregó el fondo bordado minimalista solo en la portada.
- El fondo no afecta las demás secciones de la app.
- Archivo nuevo requerido: assets/backgrounds/portada-bordado-minimalista.png
- Abrir la web con ?v=32300 para evitar caché.


v32301 — CORRECCIÓN:
- Se corrigió una regla antigua que mantenía ocultos los pseudo-elementos usados para mostrar el fondo.
- Reemplazar index.html y styles.css.
- Confirmar que exista assets/backgrounds/portada-bordado-minimalista.png.
- Abrir con ?v=32301.


v32302:
- Fondo específico vertical para celulares.
- Más nitidez, contraste y visibilidad de los bordados.
- Menor capa beige sobre el fondo.
- Caja blanca subida 14 px en móvil.
- Archivo nuevo: assets/backgrounds/portada-bordado-mobile.png
- Abrir con ?v=32302.


v32303:
- Se reemplazó el texto del título por la imagen del wordmark oficial “Vani & Fede”.
- La fecha 24 - 10 - 2026 pasó a bordó.
- Archivo nuevo: assets/branding/vani-fede-wordmark.png
- Abrir con ?v=32303.


v32304:
- Se eliminó el wordmark raster pixelado.
- “VANI & FEDE” vuelve a ser texto HTML de alta definición.
- Tipografía elegante inspirada en la invitación.
- Mantiene la fecha en bordó.
- Abrir con ?v=32304.


v32400 · INICIO MINIMALISTA
- Se eliminó el botón Compartir.
- Se eliminó Info terrenal de la navegación.
- La información terrenal pasó al final de Inicio.
- Se quitaron estadísticas y tarjetas duplicadas.
- Nuevo Inicio: equipo, asistencia, accesos rápidos e información esencial.
- Encabezado superior más compacto en escritorio y celular.
- Asistencia mantiene su sección completa sin cambios.
- Abrir con ?v=32400.


v32401 — MENÚ HAMBURGUESA:
- Se eliminó la barra horizontal de navegación.
- Las secciones pasan a un menú lateral tipo hamburguesa.
- Se quitaron las tres tarjetas de “Accesos rápidos” del Inicio para evitar duplicaciones.
- El menú incluye Inicio, Asistencia, Mi equipo, Sumá puntos, Ranking, Invitados, Admin y Salir.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32401.


v32402 — INICIO UX:
- Encabezado compacto con botón “Menú” visible.
- Inicio dinámico según asistencia y cercanía del casamiento.
- Una sola acción prioritaria por vez.
- Info terrenal integrada como lista simple y accesible.
- Detalles secundarios dentro de un desplegable.
- Estado del equipo compacto, sin tarjetas repetidas.
- Menú agrupado por Tu casamiento, El juego, Comunidad y Gestión.
- Navegación por teclado, cierre con Escape y foco contenido en el menú.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32402.


v32403:
- Menú hamburguesa con iconos SVG consistentes y más elegantes.
- “Mi equipo” ahora usa icono de grupo de personas.
- “Asistencia” se destaca en bordó oscuro.
- Se mejoraron los iconos de “Lo esencial”.
- En Mi equipo se eliminó “Estado del equipo”; queda solamente el estado de asistencia.
- “Agendalo” enlaza directamente al evento existente de Google Calendar.
- URL del evento: https://www.google.com/calendar/event?eid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&ctz=America/Argentina/Buenos_Aires
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32403.


v32404:
- Cuenta regresiva en Inicio hasta el 24/10/2026 a las 18:00, en días, horas y minutos.
- Bienvenida del equipo más compacta.
- Aviso pequeño con check cuando la asistencia ya fue registrada.
- Botón de Inicio siempre visible en la barra superior.
- Menú: “Tu casamiento” pasó a “Casamiento”.
- “Mi equipo” pasó al grupo Comunidad.
- Se eliminaron las sombras de los textos del menú.
- Los equipos del Ranking ahora son clickeables y abren la ficha del equipo seleccionado.
- Confirmación de asistencia rediseñada en tema claro.
- Botones “Agendalo” corregidos con fondo bordó y texto claro.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32404.


v32405:
- Admin simplificado: se eliminaron Google Sheets y exportación, Candados y Fichas.
- Nuevo contador de asistencia con cantidad, porcentaje, no asistentes y pendientes.
- Nuevo cargador UX para sumar/restar puntos: equipos visuales, selector sumar/restar, cantidades rápidas y resumen.
- Mi equipo incorpora acceso directo al Ranking.
- Ranking incorpora acceso directo a Sumá puntos.
- Se quitó la tarjeta “Puntos equilibrados”.
- “Foto creativa del equipo” fue reemplazada por “Trivia Vani y Fede”, próximamente.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32405.


v32406:
- Nuevo botón Admin “Resetear RSVP y formularios”.
- Limpia funcionalmente RSVP, formularios personales y respuestas de juegos.
- Usa confirmación doble: diálogo + palabra RESET.
- El reset se guarda en Google Sheets mediante una marca temporal, por lo que se aplica a todos los celulares con esta versión.
- Las filas históricas permanecen en Sheets como respaldo, pero dejan de contar y de mostrarse.
- No borra invitados ni puntos discrecionales.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32406.


v32407:
- Botón Agendalo corregido después de confirmar asistencia.
- Se quitó Sincronizar datos de la vista del invitado.
- Después de confirmar aparece “Tu próximo desafío” con acceso a Sumá puntos.
- Admin muestra estado de Google Sheets y botón Sincronizar ahora.
- Sumá puntos ya no muestra Jugadores activos ni el aviso final Importante.
- Nueva sección Trivia Vani y Fede en el menú.
- Incluye tres juegos: canciones, trivia de prueba y juego sorpresa.
- Los tres juegos pueden bloquearse o liberarse desde Admin.
- Ranking resalta al equipo que va ganando.
- Se agregó aviso de premios especiales.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32407.


v32408:
- Ranking con botón Actualizar para sincronizar los puntajes actuales.
- Juego musical funcional: completar suma puntos una sola vez con la misma escala por equipo que RSVP.
- Trivia funcional: cinco preguntas, veinte puntos por acierto y máximo de cien puntos por persona.
- Reintentos permitidos; el ranking conserva únicamente el mejor resultado.
- Admin muestra cuántas personas necesitan combi desde el Obelisco.
- Nuevo botón para exportar la lista oficial de confirmados en CSV compatible con Excel.
- La exportación incluye contacto, traslado, restricciones, comentarios y preferencias disponibles.
- Menú hamburguesa con tipografía más chica y sin fondo/sombra detrás de los textos.
- Reemplazar index.html, styles.css y app.js.
- Abrir con ?v=32408.


v32409 — CORRECCIÓN CRÍTICA DE GOOGLE SHEETS:
- El backend anterior solo escribía por doPost, pero la web enviaba las escrituras por JSONP/doGet.
- Por eso la interfaz mostraba éxito aunque los datos quedaran únicamente en localStorage.
- Code_v32409.gs agrega escrituras reales por doGet y conserva doPost.
- También corrige la contraseña Admin del backend para que coincida con config.js.
- RSVP y juegos ahora muestran éxito únicamente después de guardar y volver a leer el dato desde Sheets.
- Las respuestas completas de canciones y trivia se conservan en RESPUESTAS_JUEGOS.
- Reemplazar index.html, styles.css y app.js.
- Además, reemplazar Code.gs y crear una NUEVA VERSIÓN de la implementación Web App.
- Abrir con ?v=32409.


v32410 — OPTIMIZACIÓN DE VELOCIDAD:
- Cada guardado usa una sola solicitud a Google Apps Script.
- Apps Script devuelve en la misma respuesta el registro exacto que escribió.
- La web deja de descargar todas las hojas antes de confirmar RSVP o juegos.
- La sincronización completa ocurre luego, silenciosamente, sin bloquear al usuario.
- Apps Script ya no inicializa todas las hojas antes de cada escritura.
- Se mantiene la seguridad: la interfaz solo confirma después de que Sheets responde que guardó.
- Actualizar Code.gs y crear una NUEVA VERSIÓN de la implementación Web App.
- Reemplazar index.html, styles.css y app.js en GitHub.
- Abrir con ?v=32410.
