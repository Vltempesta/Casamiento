/**
 * Backend Google Apps Script · Vani & Fede · v32409
 *
 * IMPORTANTE:
 * El frontend usa JSONP, por lo que las lecturas Y las escrituras llegan por doGet.
 * Esta versión también conserva doPost por compatibilidad.
 *
 * Despliegue:
 * 1. Pegá este archivo completo en Apps Script.
 * 2. Guardá.
 * 3. Implementar > Administrar implementaciones.
 * 4. Editá la implementación Web App y elegí "Nueva versión".
 * 5. Ejecutar como: Yo.
 * 6. Acceso: Cualquier persona.
 */

const PUBLIC_WRITE_TOKEN = 'VF-2026-BOSQUE';
const ADMIN_PASSWORD = 'vanifyfede2026';
const BACKEND_VERSION = '32409';

const SHEETS = {
  RSVP: 'RSVP',
  PROFILES: 'FICHAS_SECRETAS',
  GAME_SUBMISSIONS: 'RESPUESTAS_JUEGOS',
  SCORES: 'PUNTAJES',
  UNLOCKS: 'CANDADOS',
  EVENTS: 'EVENTOS'
};

const HEADERS = {
  RSVP: [
    'timestamp', 'guestId', 'teamId', 'firstName', 'lastName', 'email', 'phone',
    'attendance', 'transport', 'diet', 'comment', 'resetMarker', 'resetScope',
    'updatedAt', 'submittedAt', 'appVersion', 'pageUrl', 'userAgent', 'payloadJson'
  ],
  PROFILES: [
    'timestamp', 'guestId', 'teamId', 'favoriteColor', 'songYes', 'songNo',
    'wish', 'challenge', 'favoriteFood', 'favoriteDessert', 'secret',
    'competitive', 'skill', 'weakness', 'updatedAt', 'submittedAt',
    'appVersion', 'pageUrl', 'userAgent', 'payloadJson'
  ],
  GAME_SUBMISSIONS: [
    'timestamp', 'gameId', 'guestId', 'teamId', 'answer', 'evidence', 'comment',
    'weddingSong', 'teamEntranceSong', 'reason', 'answersJson', 'score',
    'bestScore', 'earnedPoints', 'maxScore', 'updatedAt', 'submittedAt',
    'appVersion', 'pageUrl', 'userAgent', 'payloadJson'
  ],
  SCORES: [
    'timestamp', 'gameId', 'teamId', 'points', 'comment', 'adminName',
    'submittedAt', 'appVersion', 'pageUrl', 'userAgent', 'payloadJson'
  ],
  UNLOCKS: [
    'timestamp', 'key', 'open', 'adminName', 'submittedAt',
    'appVersion', 'pageUrl', 'userAgent', 'payloadJson'
  ],
  EVENTS: [
    'timestamp', 'eventName', 'guestId', 'teamId', 'payload',
    'submittedAt', 'appVersion', 'pageUrl', 'userAgent'
  ]
};

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = params.callback;
  const action = params.action || 'getData';

  try {
    let result;

    if (action === 'ping') {
      verifyToken_(params.token);
      result = {
        ok: true,
        data: {
          message: 'pong',
          backendVersion: BACKEND_VERSION,
          at: now_()
        }
      };
    } else if (action === 'getData') {
      verifyToken_(params.token);
      setupSheets_();
      result = {
        ok: true,
        data: buildData_(),
        backendVersion: BACKEND_VERSION
      };
    } else if (action === 'setup') {
      verifyToken_(params.token);
      verifyAdmin_(params.adminPassword);
      setupSheets_();
      result = {
        ok: true,
        data: {
          message: 'Hojas inicializadas',
          backendVersion: BACKEND_VERSION
        }
      };
    } else {
      const payload = parsePayload_(params.payload);
      payload.action = payload.action || action;
      payload.token = payload.token || params.token;
      verifyToken_(payload.token);

      result = withLock_(function () {
        setupSheets_();
        const saved = handleWrite_(payload);
        return {
          ok: true,
          data: {
            saved: true,
            action: payload.action,
            guestId: payload.guestId || '',
            gameId: payload.gameId || '',
            at: now_(),
            backendVersion: BACKEND_VERSION,
            details: saved || {}
          }
        };
      });
    }

    return output_(result, callback);
  } catch (error) {
    return output_({
      ok: false,
      error: error && error.message ? error.message : String(error),
      backendVersion: BACKEND_VERSION
    }, callback);
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    verifyToken_(payload.token);

    const result = withLock_(function () {
      setupSheets_();
      const saved = handleWrite_(payload);
      return {
        ok: true,
        data: {
          saved: true,
          action: payload.action,
          guestId: payload.guestId || '',
          gameId: payload.gameId || '',
          at: now_(),
          backendVersion: BACKEND_VERSION,
          details: saved || {}
        }
      };
    });

    return json_(result);
  } catch (error) {
    return json_({
      ok: false,
      error: error && error.message ? error.message : String(error),
      backendVersion: BACKEND_VERSION
    });
  }
}

function handleWrite_(payload) {
  switch (payload.action) {
    case 'saveRsvp':
      appendObject_(SHEETS.RSVP, HEADERS.RSVP, {
        ...payload,
        timestamp: payload.timestamp || now_(),
        payloadJson: JSON.stringify(payload)
      });
      return { sheet: SHEETS.RSVP };

    case 'saveProfile':
      appendObject_(SHEETS.PROFILES, HEADERS.PROFILES, {
        ...payload,
        timestamp: payload.timestamp || now_(),
        payloadJson: JSON.stringify(payload)
      });
      return { sheet: SHEETS.PROFILES };

    case 'saveGameSubmission':
      appendObject_(SHEETS.GAME_SUBMISSIONS, HEADERS.GAME_SUBMISSIONS, {
        ...payload,
        timestamp: payload.timestamp || now_(),
        answersJson: payload.answers ? JSON.stringify(payload.answers) : '',
        payloadJson: JSON.stringify(payload)
      });
      return { sheet: SHEETS.GAME_SUBMISSIONS };

    case 'saveScore':
      verifyAdmin_(payload.adminPassword);
      appendObject_(SHEETS.SCORES, HEADERS.SCORES, {
        ...payload,
        timestamp: payload.timestamp || now_(),
        points: Number(payload.points || 0),
        adminName: payload.adminName || 'admin',
        payloadJson: JSON.stringify(payload)
      });
      return { sheet: SHEETS.SCORES };

    case 'saveUnlock':
      verifyAdmin_(payload.adminPassword);
      appendObject_(SHEETS.UNLOCKS, HEADERS.UNLOCKS, {
        ...payload,
        timestamp: payload.timestamp || now_(),
        open: payload.open === true || String(payload.open).toLowerCase() === 'true',
        adminName: payload.adminName || 'admin',
        payloadJson: JSON.stringify(payload)
      });
      return { sheet: SHEETS.UNLOCKS };

    case 'logEvent':
      appendObject_(SHEETS.EVENTS, HEADERS.EVENTS, {
        timestamp: payload.timestamp || now_(),
        eventName: payload.eventName || 'event',
        guestId: payload.guestId || '',
        teamId: payload.teamId || '',
        payload: JSON.stringify(payload),
        submittedAt: payload.submittedAt || '',
        appVersion: payload.appVersion || '',
        pageUrl: payload.pageUrl || '',
        userAgent: payload.userAgent || ''
      });
      return { sheet: SHEETS.EVENTS };

    default:
      throw new Error('Acción no reconocida: ' + payload.action);
  }
}

function setupSheets_() {
  Object.keys(SHEETS).forEach(function (key) {
    ensureSheet_(SHEETS[key], HEADERS[key]);
  });
}

function ensureSheet_(name, requiredHeaders) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
  } else {
    const lastColumn = Math.max(sheet.getLastColumn(), 1);
    const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
      .map(function (value) { return String(value || '').trim(); });

    const missingHeaders = requiredHeaders.filter(function (header) {
      return currentHeaders.indexOf(header) === -1;
    });

    if (missingHeaders.length) {
      sheet.getRange(1, currentHeaders.length + 1, 1, missingHeaders.length)
        .setValues([missingHeaders]);
    }
  }

  const headerCount = sheet.getLastColumn();
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headerCount)
    .setFontWeight('bold')
    .setBackground('#1a2b1b')
    .setFontColor('#f7eed9');
}

function appendObject_(sheetName, requiredHeaders, data) {
  ensureSheet_(sheetName, requiredHeaders);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (value) { return String(value || '').trim(); });

  const row = headers.map(function (header) {
    return cellValue_(data[header]);
  });

  sheet.appendRow(row);
  SpreadsheetApp.flush();
}

function cellValue_(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function buildData_() {
  return {
    rsvps: latestBy_(rows_(SHEETS.RSVP), 'guestId', true),
    profiles: latestBy_(rows_(SHEETS.PROFILES), 'guestId', true),
    gameSubmissions: latestGameSubmissions_(rows_(SHEETS.GAME_SUBMISSIONS)),
    scoreEntries: rows_(SHEETS.SCORES).map(function (row) {
      const hydrated = hydratePayload_(row);
      return normalizeDates_({
        ...hydrated,
        timestamp: hydrated.timestamp || row.timestamp,
        gameId: hydrated.gameId || row.gameId,
        teamId: hydrated.teamId || row.teamId,
        points: Number(hydrated.points || 0),
        comment: hydrated.comment || '',
        adminName: hydrated.adminName || ''
      });
    }),
    manualUnlocks: latestUnlocks_(rows_(SHEETS.UNLOCKS)),
    generatedAt: now_(),
    backendVersion: BACKEND_VERSION
  };
}

function rows_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();

  const headers = values.shift().map(function (value) {
    return String(value || '').trim();
  });

  return values
    .map(function (row) {
      const object = {};
      headers.forEach(function (header, index) {
        if (header) object[header] = row[index];
      });
      return object;
    })
    .filter(function (row) {
      return Object.keys(row).some(function (key) {
        return row[key] !== '' && row[key] !== null;
      });
    });
}

function latestBy_(rows, key, hydrate) {
  const out = {};

  rows.forEach(function (row) {
    if (!row[key]) return;
    const value = hydrate ? hydratePayload_(row) : row;
    out[row[key]] = normalizeDates_(value);
  });

  return out;
}

function latestGameSubmissions_(rows) {
  const out = {};

  rows.forEach(function (row) {
    if (!row.guestId || !row.gameId) return;

    const hydrated = hydratePayload_(row);

    if (!hydrated.answers && row.answersJson) {
      hydrated.answers = parseJsonSafe_(row.answersJson, {});
    }

    hydrated.score = numberOrBlank_(hydrated.score);
    hydrated.bestScore = numberOrBlank_(hydrated.bestScore);
    hydrated.earnedPoints = numberOrBlank_(hydrated.earnedPoints);
    hydrated.maxScore = numberOrBlank_(hydrated.maxScore);

    out[row.guestId + '::' + row.gameId] = normalizeDates_(hydrated);
  });

  return out;
}

function latestUnlocks_(rows) {
  const out = {};

  rows.forEach(function (row) {
    if (!row.key) return;
    const hydrated = hydratePayload_(row);
    out[row.key] = hydrated.open === true ||
      String(hydrated.open).toUpperCase() === 'TRUE';
  });

  return out;
}

function hydratePayload_(row) {
  const payload = parseJsonSafe_(row.payloadJson, {});
  return {
    ...normalizeDates_(row),
    ...payload
  };
}

function normalizeDates_(row) {
  const out = { ...row };

  ['timestamp', 'updatedAt', 'submittedAt'].forEach(function (key) {
    if (out[key] instanceof Date) {
      out[key] = out[key].toISOString();
    }
  });

  return out;
}

function parsePayload_(text) {
  const payload = parseJsonSafe_(text, null);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload inválido o vacío');
  }
  return payload;
}

function parseJsonSafe_(text, fallback) {
  if (!text) return fallback;

  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch (error) {
    return fallback;
  }
}

function numberOrBlank_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function verifyToken_(token) {
  if (PUBLIC_WRITE_TOKEN && token !== PUBLIC_WRITE_TOKEN) {
    throw new Error('Token público inválido');
  }
}

function verifyAdmin_(password) {
  if (ADMIN_PASSWORD && password !== ADMIN_PASSWORD) {
    throw new Error('Clave admin inválida');
  }
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
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
