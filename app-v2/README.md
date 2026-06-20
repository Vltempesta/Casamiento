# Vani & Fede · La Convocatoria

Versión real de la web app del casamiento, lista para subir a GitHub Pages y conectada a Google Sheets mediante Google Apps Script.

## Qué incluye

- Login por invitado usando nombre, apellido, alias o mail.
- Descubrimiento de equipo.
- Info terrenal con candados por fecha o apertura manual.
- RSVP conectado a Google Sheets.
- Ficha secreta conectada a Google Sheets.
- Juegos digitales con respuestas guardadas en Google Sheets.
- Ranking por equipos.
- Panel admin para cargar puntos físicos, abrir candados, inicializar Sheets y exportar datos.
- Modo local de respaldo: si Google Sheets falla, la app sigue funcionando en el navegador.

## Archivos principales

- `index.html`: estructura de la app.
- `styles.css`: estética visual premium bosque-victoriana.
- `data.js`: invitados, equipos, fechas, textos, juegos y cronograma.
- `config.js`: conexión a Google Sheets.
- `app.js`: lógica de la app.
- `apps-script/Code.gs`: backend para Google Apps Script.

## Cómo conectarla a Google Sheets

1. Creá una Google Sheet nueva desde tu cuenta de Google.
2. Abrí la Sheet y entrá en `Extensiones > Apps Script`.
3. Borrá el contenido por defecto y pegá todo el contenido de `apps-script/Code.gs`.
4. En `Code.gs`, revisá estos valores:

```js
const PUBLIC_WRITE_TOKEN = 'VF-2026-BOSQUE';
const ADMIN_PASSWORD = 'vaniyfede2026';
```

5. Guardá el proyecto.
6. Tocá `Deploy > New deployment`.
7. Tipo: `Web app`.
8. Configurá:
   - `Execute as`: Me
   - `Who has access`: Anyone
9. Copiá la URL que termina en `/exec`.
10. Pegala en `config.js`:

```js
GOOGLE_APPS_SCRIPT_URL: "https://script.google.com/macros/s/XXXXX/exec"
```

11. Si cambiaste el token o la clave admin en Apps Script, actualizá también en `config.js`:

```js
PUBLIC_WRITE_TOKEN: "VF-2026-BOSQUE",
LOCAL_ADMIN_PASSWORD: "vaniyfede2026"
```

12. Subí todo a GitHub Pages.
13. Entrá a la app, abrí `Admin`, poné la clave y tocá `Inicializar hojas`.

Google Sheets va a crear estas pestañas automáticamente:

- `RSVP`
- `FICHAS_SECRETAS`
- `RESPUESTAS_JUEGOS`
- `PUNTAJES`
- `CANDADOS`
- `EVENTOS`

## Cómo editar invitados

Editá el array `guests` dentro de `data.js`.

Ejemplo:

```js
{ id: "nico", firstName: "Nico", lastName: "Tempesta", email: "", alias: "El hermano guapo", relation: "Familia Vani", team: "fuego", role: "invitado" }
```

Los equipos válidos son:

- `bosque`
- `fuego`
- `luz`
- `noche`
- `agua`
- `viento`

## Cómo abrir candados

Hay dos formas:

1. Por fecha, editando `unlocks` en `data.js`.
2. Manualmente desde `Admin > Candados`.

La apertura manual se guarda en Google Sheets en la pestaña `CANDADOS`.

## Cómo cargar juegos físicos

Entrá a `Admin`, seleccioná:

- Juego
- Equipo
- Puntos
- Comentario

Podés cargar puntos positivos o negativos. El ranking suma todo lo que esté en `PUNTAJES`.

## Notas importantes

- Google Apps Script puede tardar unos segundos en despertar la primera vez.
- Las respuestas se escriben con `fetch` en modo compatible con Apps Script. Aunque el navegador no siempre pueda leer la confirmación del POST, la escritura queda registrada en Sheets.
- La app mantiene copia local en `localStorage` para no perder datos si hay mala señal durante la fiesta.
- Para producción, conviene cambiar `PUBLIC_WRITE_TOKEN` y `ADMIN_PASSWORD` antes de compartir el link final.
