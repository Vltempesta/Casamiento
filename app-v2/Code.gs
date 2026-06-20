/**
 * Google Apps Script backend · Vani & Fede · La Convocatoria
 * ------------------------------------------------------------------
 * Cómo usar:
 * 1) Abrí una Google Sheet vacía.
 * 2) Extensiones > Apps Script.
 * 3) Pegá este archivo completo.
 * 4) Cambiá PUBLIC_WRITE_TOKEN y ADMIN_PASSWORD.
 * 5) Deploy > New deployment > Web app.
 *    Execute as: Me
 *    Who has access: Anyone
 * 6) Copiá la URL /exec en config.js del frontend.
 */

const PUBLIC_WRITE_TOKEN = 'VF-2026-BOSQUE';
const ADMIN_PASSWORD = 'vaniyfede2026';

const SHEETS = {
  RSVP: 'RSVP',
  PROFILES: 'FICHAS_SECRETAS',
  GAME_SUBMISSIONS: 'RESPUESTAS_JUEGOS',
  SCORES: 'PUNTAJES',
  UNLOCKS: 'CANDADOS',
  EVENTS: 'EVENTOS'
};

const HEADERS = {
  RSVP: ['timestamp', 'guestId', 'teamId', 'firstName', 'lastName', 'email', 'phone', 'attendance', 'transport', 'diet', 'comment', 'updatedAt', 'pageUrl', 'userAgent'],
  PROFILES: ['timestamp', 'guestId', 'teamId', 'favoriteColor', 'songYes', 'songNo', 'wish', 'challenge', 'favoriteFood', 'favoriteDessert', 'secret', 'competitive', 'skill', 'weakness', 'updatedAt', 'pageUrl', 'userAgent'],
  GAME_SUBMISSIONS: ['timestamp', 'gameId', 'guestId', 'teamId', 'answer', 'evidence', 'comment', 'updatedAt', 'pageUrl', 'userAgent'],
  SCORES: ['timestamp', 'gameId', 'teamId', 'points', 'comment', 'adminName', 'pageUrl', 'userAgent'],
  UNLOCKS: ['timestamp', 'key', 'open', 'adminName', 'pageUrl', 'userAgent'],
  EVENTS: ['timestamp', 'eventName', 'guestId', 'teamId', 'payload', 'pageUrl', 'userAgent']
};

function doGet(e) {
  const params = e.parameter || {};
  const callback = params.callback;
  try {
    if (params.action !== 'getData' && params.action !== 'ping') {
      verifyAdminOrToken_(params);
    } else {
      verifyToken_(params.token);
    }

    let result;
    switch (params.action || 'getData') {
      case 'ping':
        result = { ok: true, data: { message: 'pong', at: new Date().toISOString() } };
        break;
      case 'setup':
        verifyAdmin_(params.adminPassword);
        setupSheets_();
        result = { ok: true, data: { message: 'Hojas inicializadas' } };
        break;
      case 'getData':
      default:
        setupSheets_();
        result = { ok: true, data: buildData_() };
        break;
    }
    return output_(result, callback);
  } catch (error) {
    return output_({ ok: false, error: error.message }, callback);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    setupSheets_();
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    verifyToken_(payload.token);

    switch (payload.action) {
      case 'saveRsvp':
        append_(SHEETS.RSVP, HEADERS.RSVP, [
          now_(), payload.guestId, payload.teamId, payload.firstName, payload.lastName, payload.email,
          payload.phone, payload.attendance, payload.transport, payload.diet, payload.comment,
          payload.updatedAt, payload.pageUrl, payload.userAgent
        ]);
        break;

      case 'saveProfile':
        append_(SHEETS.PROFILES, HEADERS.PROFILES, [
          now_(), payload.guestId, payload.teamId, payload.favoriteColor, payload.songYes, payload.songNo,
          payload.wish, payload.challenge, payload.favoriteFood, payload.favoriteDessert, payload.secret,
          payload.competitive, payload.skill, payload.weakness, payload.updatedAt, payload.pageUrl, payload.userAgent
        ]);
        break;

      case 'saveGameSubmission':
        append_(SHEETS.GAME_SUBMISSIONS, HEADERS.GAME_SUBMISSIONS, [
          now_(), payload.gameId, payload.guestId, payload.teamId, payload.answer, payload.evidence,
          payload.comment, payload.updatedAt, payload.pageUrl, payload.userAgent
        ]);
        break;

      case 'saveScore':
        verifyAdmin_(payload.adminPassword);
        append_(SHEETS.SCORES, HEADERS.SCORES, [
          payload.timestamp || now_(), payload.gameId, payload.teamId, Number(payload.points || 0), payload.comment,
          payload.adminName || 'admin', payload.pageUrl, payload.userAgent
        ]);
        break;

      case 'saveUnlock':
        verifyAdmin_(payload.adminPassword);
        append_(SHEETS.UNLOCKS, HEADERS.UNLOCKS, [
          payload.timestamp || now_(), payload.key, String(payload.open) === 'true' || payload.open === true,
          payload.adminName || 'admin', payload.pageUrl, payload.userAgent
        ]);
        break;

      case 'logEvent':
      default:
        append_(SHEETS.EVENTS, HEADERS.EVENTS, [
          now_(), payload.eventName || payload.action || 'event', payload.guestId, payload.teamId,
          JSON.stringify(payload), payload.pageUrl, payload.userAgent
        ]);
        break;
    }

    return json_({ ok: true, data: { saved: true, at: now_() } });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  } finally {
    lock.releaseLock();
  }
}

function setupSheets_() {
  Object.keys(SHEETS).forEach(key => ensureSheet_(SHEETS[key], HEADERS[key]));
}

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a2b1b').setFontColor('#f7eed9');
    sheet.autoResizeColumns(1, headers.length);
  }
}

function append_(sheetName, headers, row) {
  ensureSheet_(sheetName, headers);
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).appendRow(row.map(value => value === undefined ? '' : value));
}

function buildData_() {
  return {
    rsvps: latestBy_(rows_(SHEETS.RSVP), 'guestId'),
    profiles: latestBy_(rows_(SHEETS.PROFILES), 'guestId'),
    gameSubmissions: latestGameSubmissions_(rows_(SHEETS.GAME_SUBMISSIONS)),
    scoreEntries: rows_(SHEETS.SCORES).map(row => ({
      timestamp: row.timestamp,
      gameId: row.gameId,
      teamId: row.teamId,
      points: Number(row.points || 0),
      comment: row.comment,
      adminName: row.adminName
    })),
    manualUnlocks: latestUnlocks_(rows_(SHEETS.UNLOCKS)),
    generatedAt: now_()
  };
}

function rows_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values.shift().map(String);
  return values.map(row => {
    const obj = {};
    headers.forEach((header, index) => obj[header] = row[index]);
    return obj;
  }).filter(row => Object.values(row).some(value => value !== '' && value !== null));
}

function latestBy_(rows, key) {
  const out = {};
  rows.forEach(row => {
    if (!row[key]) return;
    out[row[key]] = normalizeDates_(row);
  });
  return out;
}

function latestGameSubmissions_(rows) {
  const out = {};
  rows.forEach(row => {
    if (!row.guestId || !row.gameId) return;
    out[row.guestId + '::' + row.gameId] = normalizeDates_(row);
  });
  return out;
}

function latestUnlocks_(rows) {
  const out = {};
  rows.forEach(row => {
    if (!row.key) return;
    out[row.key] = String(row.open).toUpperCase() === 'TRUE' || row.open === true;
  });
  return out;
}

function normalizeDates_(row) {
  const out = { ...row };
  ['timestamp', 'updatedAt'].forEach(key => {
    if (out[key] instanceof Date) out[key] = out[key].toISOString();
  });
  return out;
}

function verifyToken_(token) {
  if (PUBLIC_WRITE_TOKEN && token !== PUBLIC_WRITE_TOKEN) throw new Error('Token público inválido');
}

function verifyAdmin_(password) {
  if (ADMIN_PASSWORD && password !== ADMIN_PASSWORD) throw new Error('Clave admin inválida');
}

function verifyAdminOrToken_(params) {
  verifyToken_(params.token);
}

function output_(payload, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(String(callback) + '(' + JSON.stringify(payload) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(payload);
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return new Date().toISOString();
}
