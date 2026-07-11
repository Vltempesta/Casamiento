/*
  CONEXIÓN GOOGLE SHEETS · Vani & Fede
  ------------------------------------
  1) Creá una Google Sheet vacía.
  2) Extensiones > Apps Script.
  3) Pegá el contenido de apps-script/Code.gs.
  4) Deploy > New deployment > Web app.
     - Execute as: Me
     - Who has access: Anyone
  5) Copiá la URL del Web App y pegala acá abajo.

  Importante: PUBLIC_WRITE_TOKEN debe coincidir con el valor de PUBLIC_WRITE_TOKEN
  dentro de apps-script/Code.gs. No es seguridad bancaria; alcanza para evitar
  escrituras accidentales de bots o URLs viejas.
*/
window.WEDDING_APP_CONFIG = {
  GOOGLE_APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyPrbpK6TltgNpqRv77mUFEi2WIN6j2fewszmyfD78vJ6S_3G3exgoe5QABXO1Ns_tr/exec",
  PUBLIC_WRITE_TOKEN: "VF-2026-BOSQUE",
  LOCAL_ADMIN_PASSWORD: "vaniyfede2026",
  ENABLE_REMOTE_SYNC: true,
  RSVP_DEADLINE_LABEL: "30 de septiembre de 2026",
  EVENT_TIMEZONE: "America/Argentina/Buenos_Aires"
};
