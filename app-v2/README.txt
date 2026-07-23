SUBIR TODO ESTO A: Casamiento/app-v2/

Archivos a reemplazar / agregar:
- index.html  (IMPORTANTE: trae cache-busting v=21000 para que no se vea lo viejo)
- app.js
- data.js
- styles.css
- carpeta assets/team-logos/
- carpeta assets/team-cards/ (opcional, pero dejala subida por si después usamos las tarjetas completas)

Cambios incluidos:
- fondo claro tipo pergamino / invitación
- logos aprobados tomados de la imagen generada, recortados como assets PNG
- oculto “Sheets conectado” y “Sincronizar” para invitados
- Google Sheets queda visible/controlable solo desde Admin

Para probar:
https://vltempesta.github.io/Casamiento/app-v2/?v=21000

Si todavía ves la versión vieja:
1) Abrí https://vltempesta.github.io/Casamiento/app-v2/styles.css?v=21000 y buscá "Logos de equipos basados".
2) Abrí https://vltempesta.github.io/Casamiento/app-v2/app.js?v=21000 y buscá "assets/team-logos".
3) Abrí https://vltempesta.github.io/Casamiento/app-v2/assets/team-logos/bosque.png?v=21000 y verificá que se vea el logo recortado.
