(() => {
  const DATA = window.WEDDING_APP_DATA;
  const CONFIG = window.WEDDING_APP_CONFIG || {};
  const CURRENT_APP_VERSION = "32454";
  const VERSION_CHECK_URL = "./version.json";
  const STORAGE_KEY = "vf_convocatoria_real_v2";
  const PENDING_WRITES_KEY = "vf_pending_writes_v1";
  const LAST_BACKUP_KEY = "vf_last_backup_at";
  const ONLINE_COPY = {
    idle: "Conexión pendiente",
    connecting: "Consultando datos…",
    saving: "Guardando cambios…",
    online: "Datos actualizados",
    saved: "Guardado correctamente",
    retrying: "Reintentando…",
    local: "Modo local",
    error: "Sin conexión"
  };

  // Puntos enteros por persona, equilibrados por cantidad de jugadores activos por equipo.
  // Fede, Vani y registros no jugadores/mascota quedan fuera del cálculo competitivo.
  const RSVP_POINTS_BY_TEAM = { bosque: 13, fuego: 10, luz: 14, noche: 14, agua: 13, viento: 11 };
  const PROFILE_POINTS_BY_TEAM = { bosque: 20, fuego: 15, luz: 21, noche: 21, agua: 19, viento: 16 };

  let currentGuest = null;
  let currentRoute = "inicio";
  let remoteStatus = "idle";
  let silentSyncTimer = null;
  let unlockSyncInterval = null;
  let unlockSyncInFlight = null;
  let fullSyncInFlight = null;
  let lastUnlockSyncAttemptAt = 0;
  let countdownTimer = null;

  const UNLOCK_SYNC_INTERVAL_MS = 30000;
  const UNLOCK_SYNC_MIN_GAP_MS = 4000;
  const FULL_SYNC_STALE_MS = 45000;
  let deferredInstallPrompt = null;
  let appUpdateCheckInFlight = null;
  let activeWriteKeys = new Set();
  let pendingWrites = loadPendingWrites();
  let pendingRetryInFlight = false;
  let saveIndicatorTimer = null;
  let adminPreviewActive = false;
  let adminPreviewOriginalGuest = null;
  let adminSimulateWeddingDay = false;
  let appReloadingForUpdate = false;
  let serviceWorkerReloadTriggered = false;
  let selectedTeamViewId = null;
  let teamCommunityTab = "mine";
  let expandedGuestTeamId = null;
  let musicEditMode = false;
  let travelMode = null;
  let triviaFocusTarget = null;
  let selectedGuestId = null;
  let suggestionMatches = [];
  let activeSuggestionIndex = -1;

  const defaultState = {
    currentGuestId: null,
    adminUnlocked: false,
    adminPassword: "",
    rsvpEditMode: false,
    profileEditMode: false,
    rsvps: {},
    profiles: {},
    gameSubmissions: {},
    scoreEntries: [],
    socialMessages: [],
    socialLikes: {},
    notificationsByGuest: {},
    manualUnlocks: {},
    unlockRevision: "",
    serverRevision: "",
    serverRanking: [],
    backendVersion: "",
    appSettings: {
      mode: "production",
      loginPrivacyMode: false,
      forceWeddingDay: false
    },
    remoteReady: false,
    lastUnlockSyncAt: null,
    dataResetAt: null,
    lastSyncAt: null,
    lastRemoteError: ""
  };

  let state = loadState();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function loadState() {
    try {
      const stored = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      // El celular sólo recuerda quién ingresó.
      // Los datos funcionales siempre llegan desde Apps Script.
      return {
        ...defaultState,
        currentGuestId: stored.currentGuestId || null,
        adminUnlocked: false,
        adminPassword: ""
      };
    } catch (error) {
      console.warn("No se pudo leer la sesión local", error);
      return {
        ...defaultState,
        adminUnlocked: false,
        adminPassword: ""
      };
    }
  }

  function saveState() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        currentGuestId: state.currentGuestId || null,
        appVersion: CONFIG.APP_VERSION || "32454"
      })
    );
  }


  function loadPendingWrites() {
    try {
      const value = JSON.parse(
        localStorage.getItem(PENDING_WRITES_KEY) || "[]"
      );
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function persistPendingWrites() {
    localStorage.setItem(
      PENDING_WRITES_KEY,
      JSON.stringify(pendingWrites)
    );
    updateSaveIndicator();
  }

  function newRequestId(action = "write") {
    if (window.crypto?.randomUUID) {
      return `${action}-${window.crypto.randomUUID()}`;
    }
    return `${action}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function writeEntityKey(action, payload = {}) {
    if (action === "saveRsvp" || action === "saveProfile") {
      return `${action}:${payload.guestId || ""}`;
    }
    if (action === "saveGameSubmission") {
      return `${action}:${payload.guestId || ""}:${payload.gameId || ""}`;
    }
    if (action === "saveSocialMessage") {
      return `${action}:${payload.messageId || payload.requestId || ""}`;
    }
    if (action === "saveSocialLike") {
      return `${action}:${payload.messageId || ""}:${payload.guestId || ""}`;
    }
    return `${action}:${payload.requestId || ""}`;
  }

  function setBackgroundSaveStatus(status, message = "") {
    const element = $("#backgroundSaveStatus");
    const text = $("#backgroundSaveText");
    if (!element || !text) return;

    if (saveIndicatorTimer) {
      window.clearTimeout(saveIndicatorTimer);
      saveIndicatorTimer = null;
    }

    element.className = `background-save-status ${status}`;
    text.textContent = message || (
      status === "saving"
        ? "Guardando en segundo plano…"
        : status === "saved"
          ? "Guardado correctamente"
          : status === "pending"
            ? "Cambio pendiente de sincronizar"
            : status === "error"
              ? "No se pudo sincronizar"
              : ""
    );

    if (status === "saved") {
      saveIndicatorTimer = window.setTimeout(() => {
        element.classList.add("hidden");
      }, 1600);
    }
  }

  function updateSaveIndicator() {
    if (pendingWrites.length) {
      setBackgroundSaveStatus(
        navigator.onLine === false ? "pending" : "saving",
        navigator.onLine === false
          ? `${pendingWrites.length} cambio${pendingWrites.length === 1 ? "" : "s"} pendiente${pendingWrites.length === 1 ? "" : "s"}`
          : "Guardando en segundo plano…"
      );
    } else {
      setBackgroundSaveStatus("saved");
    }
  }

  function markPendingRecord(record = {}, entry) {
    return {
      ...record,
      pendingSync: true,
      pendingRequestId: entry.requestId,
      syncError: Boolean(entry.syncError)
    };
  }

  function applyPendingWriteToState(entry) {
    const payload = entry.payload || {};

    if (entry.action === "saveRsvp") {
      state.rsvps[payload.guestId] = markPendingRecord(
        {
          ...(state.rsvps[payload.guestId] || {}),
          ...payload
        },
        entry
      );
    } else if (entry.action === "saveProfile") {
      state.profiles[payload.guestId] = markPendingRecord(
        {
          ...(state.profiles[payload.guestId] || {}),
          ...payload
        },
        entry
      );
    } else if (entry.action === "saveGameSubmission") {
      const key = `${payload.guestId}::${payload.gameId}`;
      state.gameSubmissions[key] = markPendingRecord(
        {
          ...(state.gameSubmissions[key] || {}),
          ...payload
        },
        entry
      );
    } else if (entry.action === "saveSocialMessage") {
      state.socialMessages = dedupeSocialMessages([
        ...(state.socialMessages || []),
        markPendingRecord(payload, entry)
      ]);
    } else if (entry.action === "saveSocialLike") {
      const key = socialLikeKey(payload.messageId, payload.guestId);
      state.socialLikes = {
        ...(state.socialLikes || {}),
        [key]: markPendingRecord(payload, entry)
      };
    }
  }

  function applyPendingWritesToState() {
    pendingWrites.forEach(applyPendingWriteToState);
  }

  function applyConfirmedWriteToState(entry, record = {}) {
    const payload = entry.payload || {};
    const confirmed = {
      ...payload,
      ...record,
      pendingSync: false,
      syncError: false
    };

    if (entry.action === "saveRsvp") {
      state.rsvps[payload.guestId] = confirmed;
    } else if (entry.action === "saveProfile") {
      state.profiles[payload.guestId] = confirmed;
    } else if (entry.action === "saveGameSubmission") {
      state.gameSubmissions[`${payload.guestId}::${payload.gameId}`] = confirmed;
    } else if (entry.action === "saveSocialMessage") {
      state.socialMessages = dedupeSocialMessages([
        ...(state.socialMessages || []).filter(item => item.messageId !== payload.messageId),
        confirmed
      ]);
    } else if (entry.action === "saveSocialLike") {
      state.socialLikes = {
        ...(state.socialLikes || {}),
        [socialLikeKey(payload.messageId, payload.guestId)]: confirmed
      };
    }
  }

  async function sendPendingWrite(entry, options = {}) {
    const writeKey = entry.writeKey || writeEntityKey(entry.action, entry.payload);
    if (activeWriteKeys.has(writeKey)) return false;

    activeWriteKeys.add(writeKey);
    setRemoteStatus("saving", "Guardando cambios…");
    updateSaveIndicator();

    const result = await writeToSheets(
      entry.action,
      {
        ...(entry.payload || {}),
        requestId: entry.requestId
      },
      { silent: true, allowPreview: false }
    );

    activeWriteKeys.delete(writeKey);

    if (!result) {
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.syncError = true;
      persistPendingWrites();
      applyPendingWriteToState(entry);
      setRemoteStatus(
        navigator.onLine === false ? "error" : "retrying",
        navigator.onLine === false ? "Sin conexión" : "Pendiente de reintento"
      );
      if (!options.silentFailure) {
        toast("El cambio se ve en la app y se reintentará automáticamente.");
      }
      return false;
    }

    const record = result.record || entry.payload || {};
    applyConfirmedWriteToState(entry, record);
    pendingWrites = pendingWrites.filter(item => item.requestId !== entry.requestId);
    persistPendingWrites();
    setRemoteStatus("saved", "Guardado correctamente");
    setBackgroundSaveStatus("saved");
    scheduleSilentSync(900);

    if (options.successMessage) {
      toast(options.successMessage);
    }

    return true;
  }

  async function queueOptimisticWrite(action, payload, options = {}) {
    if (adminPreviewActive) {
      toast("La vista previa es de solo lectura.");
      return false;
    }

    const requestId = payload.requestId || newRequestId(action);
    const writeKey = options.writeKey || writeEntityKey(action, payload);

    if (
      activeWriteKeys.has(writeKey) ||
      pendingWrites.some(item => item.writeKey === writeKey)
    ) {
      toast("Ese cambio ya se está guardando.");
      return false;
    }

    const entry = {
      requestId,
      writeKey,
      action,
      payload: {
        ...payload,
        requestId
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
      syncError: false
    };

    pendingWrites.push(entry);
    applyPendingWriteToState(entry);
    persistPendingWrites();

    options.beforeRender?.(entry);
    if (options.render !== false) renderCurrentRoute();
    options.afterRender?.(entry);

    setBackgroundSaveStatus("saving");
    void sendPendingWrite(entry, {
      successMessage: options.successMessage
    });

    return true;
  }

  async function retryPendingWrites() {
    if (
      pendingRetryInFlight ||
      !pendingWrites.length ||
      navigator.onLine === false ||
      adminPreviewActive
    ) return;

    pendingRetryInFlight = true;
    setRemoteStatus("retrying", "Reintentando cambios…");

    try {
      for (const entry of [...pendingWrites]) {
        await sendPendingWrite(entry, {
          silentFailure: true
        });
      }
    } finally {
      pendingRetryInFlight = false;
      if (!pendingWrites.length) {
        await syncFromSheets(false);
      }
    }
  }


  function appMode() {
    return state.appSettings?.mode === "test"
      ? "test"
      : "production";
  }

  function isTestMode() {
    return appMode() === "test";
  }

  function loginPrivacyEnabled() {
    return Boolean(state.appSettings?.loginPrivacyMode);
  }

  function applyRemoteAppSettings(settings = {}) {
    state.appSettings = {
      mode: settings.mode === "test" ? "test" : "production",
      loginPrivacyMode: Boolean(settings.loginPrivacyMode),
      forceWeddingDay: Boolean(settings.forceWeddingDay)
    };

    document.body.classList.toggle("app-test-mode", isTestMode());
    updateLoginPrivacyUi();
  }

  function updateLoginPrivacyUi() {
    const helper = $(".login-helper");
    const input = $("#guestName");
    const panel = $("#guestSuggestionPanel");

    if (helper) {
      helper.textContent = loginPrivacyEnabled()
        ? "Escribí tu nombre y apellido completos."
        : "Escribí tu nombre, apellido o alias.";
    }

    if (input) {
      input.placeholder = loginPrivacyEnabled()
        ? "Nombre y apellido completos…"
        : "Buscá tu nombre…";
    }

    if (loginPrivacyEnabled()) {
      panel?.classList.add("hidden");
      if (panel) panel.innerHTML = "";
    }
  }

  function renderGlobalModeBanner() {
    if (!isTestMode()) return "";
    return `
      <div class="global-test-mode-banner" role="status">
        <span aria-hidden="true">🧪</span>
        <strong>Modo prueba</strong>
        <small>Los datos están separados de Productivo.</small>
      </div>`;
  }

  function isWeddingDayMode() {
    if (state.appSettings?.forceWeddingDay || adminSimulateWeddingDay) {
      return true;
    }

    const today = new Date();
    const event = new Date(DATA.couple.eventDate);

    return (
      today.getFullYear() === event.getFullYear() &&
      today.getMonth() === event.getMonth() &&
      today.getDate() === event.getDate()
    );
  }

  function normalize(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9@.\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDateLabel(iso) {
    if (!iso) return "fecha a definir";
    try {
      return new Intl.DateTimeFormat("es-AR", {
        day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit"
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
  }

  function getTeam(id) {
    return DATA.teams[id] || DATA.teams.bosque;
  }

  function getGuestById(id) {
    return DATA.guests.find(guest => guest.id === id);
  }


  function isGuestCaptain(guest) {
    const role = normalize(guest?.role || "");
    const tags = Array.isArray(guest?.tags) ? guest.tags.map(normalize) : [];
    return role.includes("capitan") || tags.includes("capitan");
  }

  function isCompetitionGuest(guest) {
    if (!guest) return false;
    const id = normalize(guest.id || "");
    const fullName = normalize(`${guest.firstName || ""} ${guest.lastName || ""}`);
    const role = normalize(guest.role || "");
    return !(
      id === "fede-santi" ||
      id === "vani-tempesta" ||
      id === "simba" ||
      fullName === "fede santi" ||
      fullName === "vani tempesta" ||
      role.includes("novio") ||
      role.includes("novia") ||
      role.includes("mascota")
    );
  }

  function sortGuestsForDisplay(a, b) {
    const captainDiff = Number(isGuestCaptain(b)) - Number(isGuestCaptain(a));
    if (captainDiff) return captainDiff;
    return `${a.lastName || ""} ${a.firstName || ""}`.localeCompare(`${b.lastName || ""} ${b.firstName || ""}`, "es");
  }

  function teamCompetitionMembers(teamId) {
    return DATA.guests.filter(guest => guest.team === teamId && isCompetitionGuest(guest));
  }

  function teamSizeForPoints(teamId) {
    return teamCompetitionMembers(teamId).length || 1;
  }

  function rsvpPointsForTeam(teamId) {
    return RSVP_POINTS_BY_TEAM[teamId] ?? 10;
  }

  function profilePointsForTeam(teamId) {
    return PROFILE_POINTS_BY_TEAM[teamId] ?? 15;
  }

  function completedRsvpMembers(teamId) {
    return teamCompetitionMembers(teamId).filter(guest => hasCompletedRsvp(state.rsvps[guest.id]));
  }

  function completedProfileMembers(teamId) {
    return teamCompetitionMembers(teamId).filter(guest => hasCompletedProfile(state.profiles[guest.id]));
  }

  function guestFullName(guest) {
    return `${guest?.firstName || ""} ${guest?.lastName || ""}`.replace(/\s+/g, " ").trim();
  }

  function findGuest(query) {
    const wanted = normalize(query);
    if (!wanted) return null;

    const exactMatches = DATA.guests.filter(guest => {
      if (!isCompetitionGuest(guest)) return false;

      if (loginPrivacyEnabled()) {
        return normalize(guestFullName(guest)) === wanted;
      }

      const keys = [
        guest.id,
        guestFullName(guest),
        guest.firstName,
        guest.lastName,
        guest.alias,
        guest.email
      ].map(normalize).filter(Boolean);
      return keys.includes(wanted);
    });

    return exactMatches.length === 1 ? exactMatches[0] : null;
  }

  function guestSuggestionsFor(query) {
    if (loginPrivacyEnabled()) return [];
    const wanted = normalize(query);
    if (wanted.length < 2) return [];

    return DATA.guests
      .filter(guest => {
        if (!isCompetitionGuest(guest)) return false;
        const firstName = normalize(guest.firstName);
        const lastName = normalize(guest.lastName);
        const fullName = normalize(guestFullName(guest));
        return firstName.startsWith(wanted) || lastName.startsWith(wanted) || fullName.startsWith(wanted);
      })
      .sort((a, b) => guestFullName(a).localeCompare(guestFullName(b), "es"))
      .slice(0, 7);
  }

  function isConfigured() {
    return Boolean(CONFIG.ENABLE_REMOTE_SYNC && CONFIG.GOOGLE_APPS_SCRIPT_URL && CONFIG.GOOGLE_APPS_SCRIPT_URL.startsWith("http"));
  }

  function setRemoteStatus(status, message = "") {
    remoteStatus = status;
    if (["saving", "saved", "retrying"].includes(status)) {
      setBackgroundSaveStatus(
        status === "retrying" ? "pending" : status,
        message
      );
    }
    const label = message || ONLINE_COPY[status] || status;
    [$("#connectionBadge"), $("#syncBadge")].forEach(badge => {
      if (!badge) return;
      badge.textContent = label;
      badge.className = `status-pill ${status}`;
    });
  }

  function jsonp(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) {
        reject(new Error("Conexión remota no configurada"));
        return;
      }

      const callbackName = `__vfSheets_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const url = new URL(CONFIG.GOOGLE_APPS_SCRIPT_URL);
      url.searchParams.set("action", action);
      url.searchParams.set("callback", callbackName);
      url.searchParams.set("token", CONFIG.PUBLIC_WRITE_TOKEN || "");
      url.searchParams.set("_ts", `${Date.now()}_${Math.random().toString(36).slice(2)}`);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value ?? ""));

      const script = document.createElement("script");
      const timeout = window.setTimeout(() => cleanup(() => reject(new Error("La conexión tardó demasiado"))), 12000);

      function cleanup(done) {
        window.clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
        done?.();
      }

      window[callbackName] = payload => {
        cleanup(() => {
          if (payload && payload.ok !== false) resolve(payload);
          else reject(new Error(payload?.error || "Respuesta remota inválida"));
        });
      };

      script.onerror = () => cleanup(() => reject(new Error("No se pudo cargar la respuesta remota")));
      script.src = url.toString();
      document.body.appendChild(script);
    });
  }

  function buildRemoteEnvelope(action, payload) {
    return {
      action,
      token: CONFIG.PUBLIC_WRITE_TOKEN || "",
      appVersion: "32454",
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      submittedAt: new Date().toISOString(),
      environment: appMode(),
      ...payload
    };
  }

  async function writeToSheets(action, payload, options = {}) {
    if (!isConfigured()) return null;

    const adminActions = new Set([
      "saveScore",
      "saveUnlock",
      "clearSocialMessages",
      "saveAppSettings",
      "restoreBackupChunk"
    ]);

    if (
      adminPreviewActive &&
      !options.allowPreview &&
      !adminActions.has(action)
    ) {
      if (!options.silent) toast("La vista previa es de solo lectura.");
      return null;
    }

    if (navigator.onLine === false) {
      setRemoteStatus("error", "Sin conexión");
      if (!options.silent) {
        toast("No hay conexión. El cambio quedará pendiente.");
      }
      return null;
    }

    if (!state.remoteReady && action !== "logEvent") {
      setRemoteStatus("connecting", "Consultando la base oficial");
      if (!options.silent) {
        toast("Esperá unos segundos: estamos cargando la información oficial.");
      }
      await syncFromSheets(false);
      if (!state.remoteReady) return null;
    }

    const envelope = buildRemoteEnvelope(action, payload);

    try {
      const response = await jsonp(action, { payload: JSON.stringify(envelope) });
      const details = response?.data?.details || {};
      setRemoteStatus("online", "Guardado");
      state.lastRemoteError = "";
      saveState();

      return {
        response,
        details,
        record: details.record || null
      };
    } catch (error) {
      console.warn("Fallo de escritura remota", error);
      state.lastRemoteError = error.message;
      saveState();
      setRemoteStatus("error", "No se pudo guardar");
      if (!options.silent) {
        toast("No se pudo guardar. Revisá la conexión y volvé a intentar.");
      }
      return null;
    }
  }

  async function postToSheets(action, payload) {
    const result = await writeToSheets(action, payload);
    if (!result) return false;

    await syncFromSheets(false);
    return true;
  }

  function scheduleSilentSync(delay = 1800) {
    if (!isConfigured()) return;
    if (silentSyncTimer) window.clearTimeout(silentSyncTimer);

    silentSyncTimer = window.setTimeout(() => {
      silentSyncTimer = null;
      syncFromSheets(false);
    }, delay);
  }


  function normalizeUnlockSnapshot(value) {
    if (!value || typeof value !== "object") return {};

    return Object.fromEntries(
      Object.entries(value).map(([key, open]) => [
        key,
        open === true || String(open).toUpperCase() === "TRUE"
      ])
    );
  }

  function unlockSnapshotsEqual(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    if (leftKeys.length !== rightKeys.length) return false;

    return leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      Boolean(left[key]) === Boolean(right[key])
    );
  }

  function applyRemoteUnlockSnapshot(remote = {}, options = {}) {
    if (remote.appSettings) {
      applyRemoteAppSettings(remote.appSettings);
    }
    if (
      !Object.prototype.hasOwnProperty.call(remote, "manualUnlocks")
    ) {
      return false;
    }

    if (currentGuest) initializeCurrentNotifications();

    const previous = normalizeUnlockSnapshot(state.manualUnlocks);
    const next = normalizeUnlockSnapshot(remote.manualUnlocks);
    const nextRevision = String(
      remote.unlockRevision ||
      remote.revision ||
      ""
    );

    const changed =
      !unlockSnapshotsEqual(previous, next) ||
      (
        nextRevision &&
        nextRevision !== String(state.unlockRevision || "")
      );

    // El servidor es la única fuente de verdad.
    state.manualUnlocks = next;
    state.unlockRevision = nextRevision;
    state.lastUnlockSyncAt =
      remote.generatedAt ||
      new Date().toISOString();

    if (options.persist !== false) saveState();

    if (currentGuest) {
      updateSectionNavigationState();
      updateNotificationUi();

      if (changed && options.render !== false) {
        renderCurrentRoute();
      }
    }

    return changed;
  }

  async function syncUnlockState(options = {}) {
    if (!isConfigured()) return false;

    const force = Boolean(options.force);
    const render = options.render !== false;
    const now = Date.now();

    if (
      !force &&
      now - lastUnlockSyncAttemptAt < UNLOCK_SYNC_MIN_GAP_MS
    ) {
      return false;
    }

    if (unlockSyncInFlight) return unlockSyncInFlight;

    lastUnlockSyncAttemptAt = now;

    unlockSyncInFlight = (async () => {
      try {
        let response;

        try {
          response = await jsonp("getUnlockState");
        } catch (lightSyncError) {
          response = await jsonp("getData");
        }

        // Los candados se aplican apenas llega la respuesta liviana.
        const previousMode = appMode();
        const remoteState = response?.data || {};
        applyRemoteUnlockSnapshot(
          remoteState,
          { render }
        );

        if (
          remoteState.appSettings &&
          appMode() !== previousMode
        ) {
          await syncFromSheets(false);
        }

        return true;
      } catch (error) {
        console.warn(
          "No se pudo sincronizar la configuración global",
          error
        );
        return false;
      } finally {
        unlockSyncInFlight = null;
      }
    })();

    return unlockSyncInFlight;
  }


  function startUnlockAutoSync() {
    if (unlockSyncInterval) {
      window.clearInterval(unlockSyncInterval);
    }

    unlockSyncInterval = window.setInterval(() => {
      if (
        currentGuest &&
        document.visibilityState === "visible" &&
        navigator.onLine !== false
      ) {
        syncUnlockState({ render: true });
      }
    }, UNLOCK_SYNC_INTERVAL_MS);
  }

  function syncUnlocksWhenAppReturns() {
    if (
      !currentGuest ||
      document.visibilityState !== "visible" ||
      navigator.onLine === false
    ) return;

    void syncUnlockState({
      force: true,
      render: true
    });

    const lastFullSync = Date.parse(
      state.lastSyncAt || ""
    ) || 0;

    if (
      !state.remoteReady ||
      Date.now() - lastFullSync > FULL_SYNC_STALE_MS
    ) {
      void syncFromSheets(false);
    }
  }


  async function saveAndVerifyRemote(action, payload, verifier) {
    const result = await writeToSheets(action, payload);
    if (!result) return null;

    const savedRecord = result.record || {
      ...payload,
      timestamp: payload.timestamp || payload.updatedAt || new Date().toISOString(),
      submittedAt: payload.submittedAt || new Date().toISOString()
    };

    if (typeof verifier === "function" && !verifier(savedRecord, result)) {
      setRemoteStatus("error", "La confirmación no coincide");
      toast("La confirmación recibida no coincide. Volvé a intentar.");
      return null;
    }

    await syncFromSheets(false);
    return savedRecord;
  }

  function recordTimestamp(record) {
    const value = record?.updatedAt || record?.submittedAt || record?.timestamp || "";
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function resetMarkerTimestamp(records = {}) {
    return Object.values(records).reduce((latest, record) => {
      if (!record?.resetMarker || record?.resetScope !== "test-data") return latest;
      return Math.max(latest, recordTimestamp(record));
    }, 0);
  }

  function mergeRecordsAfterReset(_localRecords = {}, remoteRecords = {}, resetAt = null) {
    const cutoff = resetAt ? Date.parse(resetAt) : 0;

    // No se mezclan datos del teléfono con los de la base.
    return Object.fromEntries(
      Object.entries(remoteRecords || {}).filter(([, record]) => {
        if (!record || record.resetMarker) return false;
        return !cutoff || recordTimestamp(record) > cutoff;
      })
    );
  }


  function socialMessageTime(message) {
    return new Date(message?.timestamp || message?.updatedAt || message?.submittedAt || 0).getTime() || 0;
  }

  function dedupeSocialMessages(entries) {
    const byId = new Map();
    (entries || []).forEach(message => {
      if (!message || !message.messageId) return;
      const previous = byId.get(message.messageId);
      if (!previous || socialMessageTime(message) >= socialMessageTime(previous)) {
        byId.set(message.messageId, message);
      }
    });
    return Array.from(byId.values());
  }


  function socialLikeKey(messageId, guestId) {
    return `${String(messageId || "")}::${String(guestId || "")}`;
  }

  function activeSocialLikes() {
    return Object.values(state.socialLikes || {}).filter(like =>
      like &&
      (like.active === true || String(like.active).toUpperCase() === "TRUE")
    );
  }

  function socialLikeCount(messageId) {
    return activeSocialLikes().filter(like => like.messageId === messageId).length;
  }

  function currentGuestLikesMessage(messageId) {
    if (!currentGuest?.id) return false;
    const record = state.socialLikes?.[socialLikeKey(messageId, currentGuest.id)];
    return Boolean(
      record &&
      (record.active === true || String(record.active).toUpperCase() === "TRUE")
    );
  }

  function socialEngagementPosts(limit = 3) {
    const messages = dedupeSocialMessages(state.socialMessages || []);
    const roots = messages.filter(message => !message.parentId);

    const replyCounts = messages.reduce((counts, message) => {
      if (message.parentId) {
        counts[message.parentId] = (counts[message.parentId] || 0) + 1;
      }
      return counts;
    }, {});

    return roots
      .map(post => ({
        post,
        likes: socialLikeCount(post.messageId),
        replies: replyCounts[post.messageId] || 0
      }))
      .filter(item => item.likes > 0 || item.replies > 0)
      .sort((a, b) =>
        (b.likes + b.replies) - (a.likes + a.replies) ||
        b.likes - a.likes ||
        b.replies - a.replies ||
        socialMessageTime(b.post) - socialMessageTime(a.post)
      )
      .slice(0, limit);
  }

  function socialMessageExcerpt(value, length = 90) {
    const text = String(value || "").trim();
    return text.length > length ? `${text.slice(0, length).trim()}…` : text;
  }

  function newSocialMessageId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `social-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function formatSocialDate(value) {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat("es-AR", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
      }).format(new Date(value));
    } catch (_) {
      return "";
    }
  }

  function mergeRemoteData(remote = {}) {
    applyRemoteAppSettings(remote.appSettings || state.appSettings || {});
    state.backendVersion = String(remote.backendVersion || state.backendVersion || "");

    const remoteRsvps =
      remote.rsvps && typeof remote.rsvps === "object"
        ? remote.rsvps
        : {};
    const remoteResetMs = resetMarkerTimestamp(remoteRsvps);

    state.dataResetAt = remoteResetMs
      ? new Date(remoteResetMs).toISOString()
      : null;

    state.rsvps = mergeRecordsAfterReset(
      {},
      remoteRsvps,
      state.dataResetAt
    );

    state.profiles = mergeRecordsAfterReset(
      {},
      remote.profiles && typeof remote.profiles === "object"
        ? remote.profiles
        : {},
      state.dataResetAt
    );

    state.gameSubmissions = mergeRecordsAfterReset(
      {},
      remote.gameSubmissions &&
        typeof remote.gameSubmissions === "object"
        ? remote.gameSubmissions
        : {},
      state.dataResetAt
    );

    state.scoreEntries = Array.isArray(remote.scoreEntries)
      ? dedupeScores(remote.scoreEntries)
      : [];

    state.socialMessages = Array.isArray(remote.socialMessages)
      ? dedupeSocialMessages(remote.socialMessages)
      : [];

    state.socialLikes =
      remote.socialLikes && typeof remote.socialLikes === "object"
        ? { ...remote.socialLikes }
        : {};

    state.notificationsByGuest =
      remote.notificationsByGuest &&
      typeof remote.notificationsByGuest === "object"
        ? { ...remote.notificationsByGuest }
        : {};

    state.serverRanking = Array.isArray(remote.ranking)
      ? remote.ranking.map(row => ({
          id: String(row.id || row.teamId || ""),
          total: Number(row.total || row.points || 0)
        }))
      : [];

    state.serverRevision = String(remote.serverRevision || "");

    if (
      Object.prototype.hasOwnProperty.call(remote, "manualUnlocks")
    ) {
      applyRemoteUnlockSnapshot(
        {
          manualUnlocks: remote.manualUnlocks,
          unlockRevision: remote.unlockRevision,
          generatedAt: remote.generatedAt
        },
        {
          persist: false,
          render: false
        }
      );
    } else {
      state.manualUnlocks = {};
      state.unlockRevision = "";
    }

    state.remoteReady = true;
    state.lastSyncAt =
      remote.generatedAt ||
      new Date().toISOString();
    state.lastRemoteError = "";

    applyPendingWritesToState();
    saveState();

    if (currentGuest) {
      initializeCurrentNotifications();
      updateNotificationUi();
    }
  }

  function dedupeScores(entries) {
    const seen = new Set();
    return entries.filter(entry => {
      const key = [entry.timestamp || entry.submittedAt || "", entry.gameId, entry.teamId, entry.points, entry.comment].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function syncFromSheets(showToast = false) {
    if (!isConfigured()) {
      setRemoteStatus("idle");
      if (showToast) {
        toast("Falta configurar la conexión remota.");
      }
      return false;
    }

    if (fullSyncInFlight) {
      const runningResult = await fullSyncInFlight;
      if (showToast && runningResult) {
        toast("Datos actualizados.");
      }
      return runningResult;
    }

    setRemoteStatus("connecting");

    fullSyncInFlight = (async () => {
      try {
        const payload = await jsonp("getData");
        mergeRemoteData(payload.data || {});

        setRemoteStatus(
          "online",
          `Datos al día${
            state.lastSyncAt
              ? " · " + new Date(
                  state.lastSyncAt
                ).toLocaleTimeString(
                  "es-AR",
                  {
                    hour: "2-digit",
                    minute: "2-digit"
                  }
                )
              : ""
          }`
        );

        if (currentGuest) renderCurrentRoute();
        if (pendingWrites.length) {
          window.setTimeout(() => retryPendingWrites(), 120);
        }
        return true;
      } catch (error) {
        state.lastRemoteError = error.message;
        setRemoteStatus("error");

        if (showToast) {
          toast(
            state.remoteReady
              ? "No se pudo actualizar. No se permiten cambios hasta recuperar la conexión."
              : "No se pudo consultar la base oficial."
          );
        }

        return false;
      } finally {
        fullSyncInFlight = null;
      }
    })();

    const result = await fullSyncInFlight;

    if (showToast && result) {
      toast("Datos actualizados.");
    }

    return result;
  }


  function isUnlocked(key) {
    if (state.manualUnlocks[key] === true || state.manualUnlocks[key] === "TRUE") return true;
    const unlock = DATA.unlocks[key];
    if (!unlock) return true;
    return new Date() >= new Date(unlock.unlockAt);
  }

  function unlockCard(key) {
    const unlock = DATA.unlocks[key];
    const open = isUnlocked(key);
    return `
      <article class="mini-card ${open ? "open" : "locked"}">
        <span class="mini-icon">${open ? "🔓" : "🔒"}</span>
        <div>
          <strong>${escapeHTML(unlock.title)}</strong>
          <p>${open ? "Disponible" : escapeHTML(unlock.teaser)}</p>
          <small>${open ? "Archivo abierto" : `Se libera: ${formatDateLabel(unlock.unlockAt)}`}</small>
        </div>
      </article>`;
  }


  async function copyText(value) {
    const text = String(value || "");
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  function toast(message) {
    const host = $("#toastHost");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 3600);
  }

  function basePageUrl() {
    return `${location.pathname}${location.search}`;
  }



  async function clearStaticAppCaches() {
    if (!("caches" in window)) return;

    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key =>
          key.startsWith("vani-fede-static-")
        )
        .map(key => caches.delete(key))
    );
  }

  function latestVersionUrl() {
    const url = new URL(
      VERSION_CHECK_URL,
      window.location.href
    );

    url.searchParams.set("_ts", String(Date.now()));
    return url.href;
  }

  async function checkForAppUpdate(options = {}) {
    const forceReload = options.forceReload !== false;

    if (appUpdateCheckInFlight) {
      return appUpdateCheckInFlight;
    }

    appUpdateCheckInFlight = (async () => {
      try {
        const response = await fetch(
          latestVersionUrl(),
          {
            cache: "no-store",
            headers: {
              "Cache-Control": "no-cache"
            }
          }
        );

        if (!response.ok) return false;

        const remote = await response.json();
        const remoteVersion = String(
          remote?.version || ""
        ).trim();

        if (
          !remoteVersion ||
          remoteVersion === CURRENT_APP_VERSION
        ) {
          return false;
        }

        if (!forceReload || appReloadingForUpdate) {
          return true;
        }

        appReloadingForUpdate = true;
        document.documentElement.dataset.appUpdating = "true";

        await clearStaticAppCaches();

        if ("serviceWorker" in navigator) {
          const registration =
            await navigator.serviceWorker.getRegistration("./");

          await registration?.update();
        }

        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("v", remoteVersion);
        nextUrl.searchParams.set(
          "_refresh",
          String(Date.now())
        );

        window.location.replace(nextUrl.href);
        return true;
      } catch (error) {
        console.warn(
          "No se pudo comprobar la última versión",
          error
        );
        return false;
      } finally {
        appUpdateCheckInFlight = null;
      }
    })();

    return appUpdateCheckInFlight;
  }

  function checkVersionWhenAppReturns() {
    if (
      document.visibilityState !== "visible" ||
      navigator.onLine === false ||
      appReloadingForUpdate
    ) return;

    void checkForAppUpdate();
  }

  function isAppInstalled() {
    return Boolean(
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIosDevice() {
    return Boolean(
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (
        navigator.platform === "MacIntel" &&
        navigator.maxTouchPoints > 1
      )
    );
  }

  function updateInstallButtons() {
    const canInstall =
      !isAppInstalled() &&
      (
        Boolean(deferredInstallPrompt) ||
        isIosDevice()
      );

    $$("[data-install-app]").forEach(button => {
      button.classList.toggle("hidden", !canInstall);
      button.hidden = !canInstall;
    });

    $(".menu-install-group")?.classList.toggle(
      "hidden",
      !canInstall
    );
  }

  async function promptInstallApp() {
    if (isAppInstalled()) {
      toast("La app ya está instalada.");
      return;
    }

    if (!deferredInstallPrompt) {
      toast(
        isIosDevice()
          ? "En Safari, tocá Compartir y después “Agregar a pantalla de inicio”."
          : "En Chrome, abrí el menú ⋮ y elegí “Instalar app”."
      );
      return;
    }

    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;

    deferredInstallPrompt = null;
    updateInstallButtons();

    if (choice.outcome === "accepted") {
      toast("La app se está instalando.");
    }
  }


  function bindInstallButtons(root = document) {
    $$("[data-install-app]", root).forEach(button => {
      if (button.dataset.installBound === "true") return;

      button.dataset.installBound = "true";
      button.addEventListener(
        "click",
        promptInstallApp
      );
    });

    updateInstallButtons();
  }

  function configureInstallExperience() {
    window.addEventListener(
      "beforeinstallprompt",
      event => {
        event.preventDefault();
        deferredInstallPrompt = event;
        updateInstallButtons();
      }
    );

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      updateInstallButtons();
      toast("Vani & Fede quedó instalada.");
    });

    const displayMode = window.matchMedia(
      "(display-mode: standalone)"
    );

    displayMode.addEventListener?.(
      "change",
      updateInstallButtons
    );

    updateInstallButtons();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        if (
          serviceWorkerReloadTriggered ||
          appReloadingForUpdate
        ) return;

        serviceWorkerReloadTriggered = true;
        window.location.reload();
      }
    );

    window.addEventListener("load", async () => {
      try {
        const registration =
          await navigator.serviceWorker.register(
            "./sw.js",
            {
              scope: "./",
              updateViaCache: "none"
            }
          );

        await registration.update();
        await checkForAppUpdate();
      } catch (error) {
        console.warn(
          "No se pudo registrar o actualizar el Service Worker",
          error
        );
      }
    });
  }

  function boot() {
    setRemoteStatus(isConfigured() ? "connecting" : "idle");
    history.replaceState({ screen: "login" }, "", basePageUrl());
    applyPendingWritesToState();
    updateLoginPrivacyUi();
    fillGuestSuggestions();
    configureNavigation();
    configureInstallExperience();
    registerServiceWorker();
    void checkForAppUpdate();
    bindShellEvents();
    window.addEventListener("popstate", handleBrowserNavigation);
    window.addEventListener("focus", () => {
      syncUnlocksWhenAppReturns();
      checkVersionWhenAppReturns();
    });

    window.addEventListener("online", () => {
      syncUnlocksWhenAppReturns();
      checkVersionWhenAppReturns();
      retryPendingWrites();
    });

    window.addEventListener("pageshow", () => {
      checkVersionWhenAppReturns();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        syncUnlocksWhenAppReturns();
        checkVersionWhenAppReturns();
      }
    });
    startUnlockAutoSync();

    if (state.currentGuestId) {
      const guest = getGuestById(state.currentGuestId);
      if (guest && isCompetitionGuest(guest)) enterApp(guest, false, "push");
    }
    syncFromSheets(false);
  }

  function applyGuestShell(guest) {
    currentGuest = guest;
    const team = getTeam(guest.team);
    document.documentElement.style.setProperty("--team-accent", team.accent || "#c8a75d");
    $("#loginScreen").classList.add("hidden");
    $("#mainScreen").classList.remove("hidden");
    $("#welcomeTitle").textContent = guest.firstName || guestFullName(guest);
    $("#welcomeInitial").textContent = (guest.firstName || guest.lastName || "V").charAt(0).toUpperCase();

    migrateSectionNotificationBaselineBeforeSync();
    updateNotificationUi();

    window.setTimeout(() => {
      syncUnlockState({
        force: true,
        render: true
      });
    }, 0);
  }

  function showLandingFromHistory() {
    closeMenu();
    currentGuest = null;
    $("#mainScreen").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function handleBrowserNavigation(event) {
    closeMenu();
    setNotificationPanelOpen(false);

    const destination = event.state || { screen: "login" };

    if (destination.screen !== "app") {
      showLandingFromHistory();
      return;
    }

    const guest = getGuestById(
      destination.guestId || state.currentGuestId
    );

    if (!guest || !isCompetitionGuest(guest)) {
      showLandingFromHistory();
      return;
    }

    applyGuestShell(guest);
    selectedTeamViewId = null;

    navigate(
      destination.route || "inicio",
      {
        historyMode: "none",
        fromHistory: true
      }
    );
  }


  function fillGuestSuggestions() {
    const input = $("#guestName");
    const panel = $("#guestSuggestionPanel");
    if (!input || !panel) return;

    function closeSuggestions() {
      suggestionMatches = [];
      activeSuggestionIndex = -1;
      panel.innerHTML = "";
      panel.classList.add("hidden");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function selectSuggestion(guest) {
      selectedGuestId = guest.id;
      input.value = guestFullName(guest);
      input.removeAttribute("aria-invalid");
      $("#loginMessage").textContent = "";
      closeSuggestions();
      input.focus();
    }

    function updateActiveSuggestion() {
      const options = $$(".guest-suggestion", panel);
      options.forEach((option, index) => option.classList.toggle("active", index === activeSuggestionIndex));
      if (activeSuggestionIndex >= 0 && options[activeSuggestionIndex]) {
        const active = options[activeSuggestionIndex];
        input.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function renderSuggestions() {
      suggestionMatches = guestSuggestionsFor(input.value);
      activeSuggestionIndex = -1;

      if (!suggestionMatches.length) {
        closeSuggestions();
        return;
      }

      panel.innerHTML = suggestionMatches.map((guest, index) => {
        const fullName = guestFullName(guest);
        const initial = escapeHTML((guest.firstName || guest.lastName || "V").charAt(0).toUpperCase());
        return `
          <button id="guest-option-${index}" class="guest-suggestion guest-suggestion--name-only" type="button" role="option" data-guest-id="${escapeHTML(guest.id)}" aria-selected="false">
            <span class="guest-suggestion-mark" aria-hidden="true">${initial}</span>
            <span><strong>${escapeHTML(fullName)}</strong></span>
          </button>`;
      }).join("");

      panel.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
    }

    input.addEventListener("input", () => {
      selectedGuestId = null;
      input.removeAttribute("aria-invalid");
      $("#loginMessage").textContent = "";
      renderSuggestions();
    });

    input.addEventListener("focus", () => {
      if (!selectedGuestId) renderSuggestions();
    });

    input.addEventListener("keydown", event => {
      if (panel.classList.contains("hidden")) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, suggestionMatches.length - 1);
        updateActiveSuggestion();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
        updateActiveSuggestion();
      } else if (event.key === "Enter" && activeSuggestionIndex >= 0) {
        event.preventDefault();
        selectSuggestion(suggestionMatches[activeSuggestionIndex]);
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
    });

    panel.addEventListener("pointerdown", event => {
      const option = event.target.closest("[data-guest-id]");
      if (!option) return;
      event.preventDefault();
      const guest = getGuestById(option.dataset.guestId);
      if (guest) selectSuggestion(guest);
    });

    document.addEventListener("pointerdown", event => {
      if (!event.target.closest(".guest-search")) closeSuggestions();
    });
  }

  function configureNavigation() {
    const infoButton = $('.nav-tabs button[data-route="info"]');
    if (infoButton) infoButton.remove();

    const fichaButton = $('.nav-tabs button[data-route="ficha"]');
    if (fichaButton) fichaButton.remove();

    const torneoButton = $('.nav-tabs button[data-route="torneo"]');
    if (torneoButton) {
      torneoButton.dataset.route = "puntos";
      torneoButton.textContent = "Sumá puntos!";
    }

    const juegosButton = $('.nav-tabs button[data-route="juegos"]');
    if (juegosButton) juegosButton.remove();
  }


  function setMenuOpen(open) {
    const menu = $("#mainMenu");
    const backdrop = $("#menuBackdrop");
    const button = $("#menuButton");
    if (!menu || !backdrop || !button) return;

    menu.classList.toggle("open", open);
    menu.setAttribute("aria-hidden", String(!open));
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
    backdrop.classList.toggle("hidden", !open);
    document.body.classList.toggle("menu-open", open);

    if (open) {
      window.setTimeout(() => $("#menuCloseButton")?.focus(), 40);
    } else if (document.activeElement?.closest?.("#mainMenu")) {
      button.focus();
    }
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  function bindShellEvents() {
    bindInstallButtons();

    $("#notificationButton")?.addEventListener("click", event => {
      event.stopPropagation();
      const panel = $("#notificationPanel");
      setNotificationPanelOpen(panel?.classList.contains("hidden"));
    });

    $("#notificationCloseButton")?.addEventListener("click", () => {
      setNotificationPanelOpen(false);
    });

    $("#notificationPanel")?.addEventListener("click", event => {
      const item = event.target.closest("[data-notification-route]");
      if (!item) return;

      markSingleNotification(
        item.dataset.notificationType,
        item.dataset.notificationKey
      );
      if (item.dataset.notificationTab === "all") {
        teamCommunityTab = "all";
      }

      updateNotificationUi();
      setNotificationPanelOpen(false);
      navigate(item.dataset.notificationRoute);
    });

    document.addEventListener("click", event => {
      if (
        event.target.closest("#notificationPanel") ||
        event.target.closest("#notificationButton")
      ) return;
      setNotificationPanelOpen(false);
    });

    $("#menuButton")?.addEventListener("click", () => {
      const isOpen = $("#mainMenu")?.classList.contains("open");
      setNotificationPanelOpen(false);
      setMenuOpen(!isOpen);
    });

    $("#menuCloseButton")?.addEventListener("click", closeMenu);
    $("#menuBackdrop")?.addEventListener("click", closeMenu);

    document.addEventListener("keydown", event => {
      const menu = $("#mainMenu");
      if (!menu?.classList.contains("open")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }

      if (event.key === "Tab") {
        const focusable = $$("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])", menu)
          .filter(element => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    $("#loginForm").addEventListener("submit", event => {
      event.preventDefault();
      const input = $("#guestName");
      const button = $("#loginButton");
      const buttonLabel = $("span", button);
      const message = $("#loginMessage");
      const guest = (selectedGuestId && getGuestById(selectedGuestId)) || findGuest(input.value);

      if (!normalize(input.value)) {
        input.setAttribute("aria-invalid", "true");
        message.textContent = "Escribí tu nombre para encontrar la invitación.";
        input.focus();
        return;
      }

      if (!guest) {
        input.setAttribute("aria-invalid", "true");
        message.textContent = loginPrivacyEnabled()
          ? "No encontramos ese nombre. Escribí nombre y apellido completos."
          : suggestionMatches.length
            ? "Elegí tu nombre de la lista para ingresar correctamente."
            : "No encontramos ese nombre. Probá escribiendo solamente tu nombre o apellido.";
        input.focus();
        return;
      }

      input.removeAttribute("aria-invalid");
      message.textContent = "";
      button.disabled = true;
      buttonLabel.textContent = "Ingresando…";

      window.setTimeout(() => {
        enterApp(guest, true);
        postToSheets("logEvent", { eventName: "login", guestId: guest.id, teamId: guest.team });
        button.disabled = false;
        buttonLabel.textContent = "Ingresar";
      }, 180);
    });

    $("#logoutButton").addEventListener("click", () => {
      closeMenu();
      state.adminUnlocked = false;
      state.adminPassword = "";
      currentGuest = null;
      state.currentGuestId = null;
      saveState();
      history.replaceState({ screen: "login" }, "", basePageUrl());
      $("#mainScreen").classList.add("hidden");
      $("#loginScreen").classList.remove("hidden");
      selectedGuestId = null;
      suggestionMatches = [];
      activeSuggestionIndex = -1;
      $("#guestName").value = "";
      $("#guestName").removeAttribute("aria-invalid");
      $("#loginMessage").textContent = "";
      $("#guestName").focus();
    });

    $("#homeButton")?.addEventListener("click", () => {
      selectedTeamViewId = null;
      navigate("inicio");
      closeMenu();
    });

    $("#syncButton").addEventListener("click", () => syncFromSheets(true));

    $$(".nav-tabs button[data-route], .bottom-nav button[data-route]").forEach(button => {
      button.addEventListener("click", () => {
        if (button.dataset.route === "equipo") selectedTeamViewId = currentGuest?.team || null;
        navigate(button.dataset.route);
        closeMenu();
      });
    });
  }

  function enterApp(guest, showWelcome, historyMode = "push") {
    applyGuestShell(guest);
    state.currentGuestId = guest.id;
    saveState();
    navigate("inicio", { historyMode });
    if (showWelcome) toast(`Acceso concedido · Equipo ${getTeam(guest.team).name}.`);
  }

  function navigate(route, options = {}) {
    if (route === "ficha" || route === "juegos" || route === "info") route = "inicio";
    if (route === "torneo") route = "puntos";

    const gameRoutes = ["musica", "trivia-pareja", "trivia-quien", "trivia"];
    if (currentGuest && gameRoutes.includes(route) && !hasFinalRsvp(state.rsvps[currentGuest.id])) {
      toast("Primero confirmá tu asistencia por sí o por no.");
      route = "asistencia";
    }

    const triviaTargets = {
      musica: "music-game",
      "trivia-pareja": "couple-trivia-game",
      "trivia-quien": "who-is-who-game"
    };
    if (triviaTargets[route]) {
      triviaFocusTarget = triviaTargets[route];
      route = "trivia";
    } else if (route !== "trivia") {
      triviaFocusTarget = null;
    }

    currentRoute = route;
    $$(".nav-tabs button[data-route], .bottom-nav button[data-route]").forEach(button => {
      const active = button.dataset.route === route;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    const historyMode = options.historyMode || "push";
    if (currentGuest && historyMode !== "none") {
      const historyState = { screen: "app", route, guestId: currentGuest.id };
      const url = `${basePageUrl()}#${encodeURIComponent(route)}`;
      if (historyMode === "replace") history.replaceState(historyState, "", url);
      else history.pushState(historyState, "", url);
    }

    renderCurrentRoute();

    if (
      currentGuest &&
      (
        !state.lastUnlockSyncAt ||
        Date.now() - Date.parse(state.lastUnlockSyncAt) >
          UNLOCK_SYNC_MIN_GAP_MS
      )
    ) {
      syncUnlockState({ render: true });
    }

    window.requestAnimationFrame(() => {
      if (route === "trivia" && triviaFocusTarget) {
        document.getElementById(triviaFocusTarget)?.scrollIntoView({ behavior: "auto", block: "start" });
      } else {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
    });
  }


  function renderLoadingSkeleton() {
    const hasError = Boolean(state.lastRemoteError);
    return `
      <section class="app-loading-skeleton section-card">
        <div class="skeleton-head">
          <span class="skeleton-block skeleton-circle"></span>
          <span class="skeleton-block skeleton-title"></span>
        </div>
        <span class="skeleton-block skeleton-line"></span>
        <span class="skeleton-block skeleton-line short"></span>
        <div class="skeleton-grid">
          <span class="skeleton-block skeleton-card"></span>
          <span class="skeleton-block skeleton-card"></span>
          <span class="skeleton-block skeleton-card"></span>
        </div>
        <p>${hasError ? "No pudimos consultar la base oficial. Revisá la conexión y tocá Sincronizar." : "Cargando la información actualizada…"}</p>
      </section>`;
  }

  function renderAdminPreviewBanner() {
    if (!adminPreviewActive || !currentGuest) return "";
    return `
      <section class="admin-preview-banner">
        <span aria-hidden="true">👁️</span>
        <div>
          <strong>Vista previa: ${escapeHTML(guestFullName(currentGuest))}</strong>
          <small>Solo lectura · no modifica sus datos</small>
        </div>
        <button type="button" data-exit-admin-preview>Volver a Admin</button>
      </section>`;
  }

  function startAdminGuestPreview(guestId) {
    const guest = getGuestById(guestId);
    if (!guest || !isCompetitionGuest(guest)) {
      toast("Elegí un invitado válido.");
      return;
    }

    adminPreviewOriginalGuest = currentGuest;
    adminPreviewActive = true;
    currentGuest = guest;
    currentRoute = "inicio";

    const team = getTeam(guest.team);
    document.documentElement.style.setProperty(
      "--team-accent",
      team.accent || "#c8a75d"
    );
    $("#welcomeTitle").textContent = guest.firstName || guestFullName(guest);
    $("#welcomeInitial").textContent = (guest.firstName || "V").charAt(0).toUpperCase();
    document.body.classList.add("admin-preview-mode");
    renderCurrentRoute();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function exitAdminGuestPreview() {
    if (!adminPreviewActive) return;

    currentGuest = adminPreviewOriginalGuest || getGuestById(state.currentGuestId);
    adminPreviewOriginalGuest = null;
    adminPreviewActive = false;
    currentRoute = "admin";
    document.body.classList.remove("admin-preview-mode");

    if (currentGuest) {
      const team = getTeam(currentGuest.team);
      document.documentElement.style.setProperty("--team-accent", team.accent || "#c8a75d");
      $("#welcomeTitle").textContent = currentGuest.firstName || guestFullName(currentGuest);
      $("#welcomeInitial").textContent = (currentGuest.firstName || "V").charAt(0).toUpperCase();
    }

    renderCurrentRoute();
  }

  function renderCurrentRoute() {
    const routes = {
      inicio: renderHome,
      asistencia: renderRSVP,
      traslado: renderTransport,
      ubicacion: renderLocation,
      cronograma: renderSchedule,
      "en-viaje": renderTravel,
      reglas: renderRules,
      equipo: renderTeam,
      puntos: renderPointsHub,
      trivia: renderTriviaHub,
      ranking: renderRanking,
      invitados: renderGuests,
      social: renderSocial,
      regalos: renderGifts,
      admin: renderAdmin
    };

    updateSectionNavigationState();

    const routeHtml = !state.remoteReady && currentRoute !== "admin"
      ? renderLoadingSkeleton()
      : !isSectionOpen(currentRoute)
        ? renderLockedSection(currentRoute)
        : (routes[currentRoute] || renderHome)();

    const html = `
      ${renderGlobalModeBanner()}
      ${renderAdminPreviewBanner()}
      ${routeHtml}
    `;

    $("#view").innerHTML = html;
    $("[data-exit-admin-preview]")?.addEventListener("click", exitAdminGuestPreview);
    bindInstallButtons($("#view"));
    markNotificationsForRoute(currentRoute);
    updateNotificationUi();
    bindViewEvents(currentRoute);
  }


  function sectionHeader(kicker, title, text) {
    return `
      <div class="section-head">
        <p class="eyebrow">${escapeHTML(kicker)}</p>
        <h3>${escapeHTML(title)}</h3>
        ${text ? `<p>${escapeHTML(text)}</p>` : ""}
      </div>`;
  }


  function teamLogo(team, className = "") {
    if (!team) return "";
    const cls = className ? ` ${className}` : "";
    const src = `assets/team-logos/${team.id}.png?v=31000`;
    return `<span class="team-logo team-logo--${team.id}${cls}" aria-label="${escapeHTML(team.name)}"><img src="${src}" alt="Logo ${escapeHTML(team.name)}" loading="lazy"></span>`;
  }

  function teamBadge(team, text = `Equipo ${team.name}`) {
    return `<span class="badge badge-team">${teamLogo(team, "badge-team-logo")}<span>${escapeHTML(text)}</span></span>`;
  }

  function actionCard(route, title, detail, icon, done = false) {
    return `
      <button class="action-card ${done ? "done" : ""}" type="button" data-go="${route}">
        <span>${icon}</span>
        <strong>${escapeHTML(title)}</strong>
        <small>${escapeHTML(detail)}</small>
      </button>`;
  }


  function uiIcon(name, className = "") {
    const icons = {
      mail: '<path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/>',
      sparkle: '<path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
      hourglass: '<path d="M6 3h12M6 21h12"/><path d="M8 3c0 4 1.4 5.7 4 7 2.6-1.3 4-3 4-7"/><path d="M8 21c0-4 1.4-5.7 4-7 2.6 1.3 4 3 4 7"/>',
      star: '<path d="M12 3 14.6 8.3 20.5 9.2 16.2 13.3 17.2 19.2 12 16.4 6.8 19.2 7.8 13.3 3.5 9.2 9.4 8.3 12 3Z"/>',
      calendar: '<path d="M8 3h8"/><path d="M9 2v3M15 2v3"/><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16"/><path d="M8 13h3M8 16h5"/>',
      calendarCheck: '<path d="M8 3h8"/><path d="M9 2v3M15 2v3"/><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16"/><path d="m8 14 2.2 2.2L16 11"/>',
      heart: '<path d="M20.8 5.8a5.1 5.1 0 0 0-7.2 0L12 7.4l-1.6-1.6a5.1 5.1 0 0 0-7.2 7.2L12 21l8.8-8a5.1 5.1 0 0 0 0-7.2Z"/>',
      pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
      bus: '<rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 7h8"/><circle cx="8" cy="18" r="1"/><circle cx="16" cy="18" r="1"/>',
      dress: '<path d="M10 3h4l1 4-2 2 4 11H7l4-11-2-2 1-4Z"/><path d="M9 7h6"/>',
      food: '<path d="M7 3v7M4.5 3v4.5A2.5 2.5 0 0 0 7 10M9.5 3v4.5A2.5 2.5 0 0 1 7 10v11"/><path d="M15 3v18"/><path d="M15 3c3.2 0 5 2.1 5 5.2 0 3.2-1.8 5.3-5 5.3"/>',
      calendarPlus: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M12 13v5M9.5 15.5h5"/>',
      checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/>',
      ranking: '<path d="M5 20V10h4v10"/><path d="M10 20V4h4v16"/><path d="M15 20v-7h4v7"/>',
      play: '<path d="M8 5v14l11-7-11-7Z"/>',
      music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      gift: '<path d="M4 10h16v10H4z"/><path d="M3 7h18v3H3zM12 7v13"/><path d="M12 7c-3.5 0-5-1.1-5-2.6C7 3.2 8 3 8.8 3 10.3 3 12 5.2 12 7ZM12 7c3.5 0 5-1.1 5-2.6C17 3.2 16 3 15.2 3 13.7 3 12 5.2 12 7Z"/>',
      sync: '<path d="M20 7h-5V2"/><path d="M4 17h5v5"/><path d="M6.1 8A7 7 0 0 1 18.5 5.5L20 7"/><path d="M17.9 16A7 7 0 0 1 5.5 18.5L4 17"/>',
      question: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.7 2c-1 .6-1.5 1.1-1.5 2.2"/><path d="M12 17h.01"/>',
      chat: '<path d="M4 5h11a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4H9l-5 4v-4a4 4 0 0 1-2-3.5V9a4 4 0 0 1 2-4Z"/><path d="M7 9h7M7 12h4"/>',
      person: '<circle cx="12" cy="8" r="3"/><path d="M5.5 20c.6-4.3 2.8-6.5 6.5-6.5s5.9 2.2 6.5 6.5"/>',
      download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
      car: '<path d="M5 17h14l-1.5-6h-11L5 17Z"/><path d="m7 11 1.5-4h7L17 11"/><circle cx="8" cy="17" r="1.5"/><circle cx="16" cy="17" r="1.5"/><path d="M5 14H3M21 14h-2"/>',
      road: '<path d="M9 21 11 3h2l2 18"/><path d="M12 6v3M12 12v3M12 18v2"/>',
      rules: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/><path d="m6.5 8 .5.5 1-1"/>',
      phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10 5h4M11 18.5h2"/>'
    };
    const path = icons[name] || icons.sparkle;
    const cls = className ? ` ${className}` : "";
    return `<svg class="ui-icon${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }


  function countdownValues() {
    const target = new Date("2026-10-24T18:00:00-03:00").getTime();
    const remaining = Math.max(0, target - Date.now());
    const totalMinutes = Math.floor(remaining / 60000);
    return {
      finished: remaining <= 0,
      days: Math.floor(totalMinutes / 1440),
      hours: Math.floor((totalMinutes % 1440) / 60),
      minutes: totalMinutes % 60
    };
  }

  function updateHomeCountdown() {
    const container = $("#homeCountdown");
    if (!container) return;

    const values = countdownValues();
    const days = $("#countdownDays");
    const hours = $("#countdownHours");
    const minutes = $("#countdownMinutes");
    const label = $("#countdownLabel");

    if (values.finished) {
      label.textContent = "¡Hoy celebramos!";
      days.textContent = "0";
      hours.textContent = "0";
      minutes.textContent = "0";
      return;
    }

    label.textContent = "Faltan";
    days.textContent = String(values.days);
    hours.textContent = String(values.hours).padStart(2, "0");
    minutes.textContent = String(values.minutes).padStart(2, "0");
  }

  function startHomeCountdown() {
    if (countdownTimer) window.clearInterval(countdownTimer);
    updateHomeCountdown();
    countdownTimer = window.setInterval(updateHomeCountdown, 30000);
  }


  const TRIVIA_GAME_DEFAULTS = {
    "trivia-music": true,
    "trivia-couple": true,
    "trivia-who": true,
    "transport-info": false,
    "gifts-section": false
  };


  const SECTION_DEFINITIONS = [
    { route: "asistencia", key: "section-asistencia", title: "Asistencia", text: "Confirmación, traslado y restricciones.", defaultOpen: true },
    { route: "traslado", key: "transport-info", title: "Traslados", text: "Información de micros y viaje particular.", defaultOpen: true },
    { route: "ubicacion", key: "location-section", title: "Ubicación", text: "Locación, mapa e indicaciones para llegar.", defaultOpen: false },
    { route: "cronograma", key: "schedule-section", title: "Cronograma", text: "Horarios principales del casamiento.", defaultOpen: true },
    { route: "en-viaje", key: "travel-section", title: "En viaje", text: "Consignas, playlist y trivias del recorrido.", defaultOpen: false },
    { route: "reglas", key: "rules-section", title: "Reglas", text: "Cómo se suman y restan puntos.", defaultOpen: true },
    { route: "puntos", key: "section-puntos", title: "Sumá puntos", text: "Juegos y desafíos.", defaultOpen: true },
    { route: "ranking", key: "section-ranking", title: "Ranking", text: "Tabla de posiciones.", defaultOpen: true },
    { route: "equipo", key: "section-equipo", title: "Mi equipo", text: "Integrantes y progreso.", defaultOpen: true },
    { route: "invitados", key: "section-invitados", title: "Invitados", text: "Mapa de equipos.", defaultOpen: true },
    { route: "social", key: "section-social", title: "Social", text: "Mensajes, likes y respuestas.", defaultOpen: true },
    { route: "regalos", key: "gifts-section", title: "Regalos", text: "Información de regalos.", defaultOpen: false }
  ];

  function sectionDefinition(route) {
    const normalizedRoute = route === "trivia" ? "puntos" : route;
    return SECTION_DEFINITIONS.find(item => item.route === normalizedRoute) || null;
  }

  function isSectionOpen(route) {
    if (["inicio", "admin"].includes(route)) return true;
    const definition = sectionDefinition(route);
    if (!definition) return true;

    if (Object.prototype.hasOwnProperty.call(state.manualUnlocks || {}, definition.key)) {
      return state.manualUnlocks[definition.key] === true ||
        String(state.manualUnlocks[definition.key]).toUpperCase() === "TRUE";
    }
    return definition.defaultOpen;
  }

  function sectionLabelForKey(key) {
    return SECTION_DEFINITIONS.find(item => item.key === key)?.title || "Sección";
  }

  function updateSectionNavigationState() {
    $$("[data-route]").forEach(button => {
      const route = button.dataset.route;
      const hiddenByLock = !isSectionOpen(route);

      button.classList.remove("is-section-locked");
      button.classList.toggle("hidden", hiddenByLock);

      if (hiddenByLock) {
        button.setAttribute(
          "aria-label",
          `${sectionDefinition(route)?.title || route}: oculta`
        );
      } else {
        button.removeAttribute("aria-label");
      }
    });

    $$(".menu-group").forEach(group => {
      const hasVisibleButton = Boolean(
        group.querySelector("button[data-route]:not(.hidden)")
      );
      group.classList.toggle("hidden", !hasVisibleButton);
    });

    const bottomNav = $(".bottom-nav");
    if (bottomNav) {
      const visibleItems = bottomNav.querySelectorAll(
        "button[data-route]:not(.hidden)"
      ).length;
      bottomNav.style.setProperty(
        "--bottom-count",
        String(Math.max(1, visibleItems))
      );
    }
  }

  function renderLockedSection(route) {
    const definition = sectionDefinition(route) || {
      title: "Sección",
      text: "Este contenido se habilitará más adelante."
    };

    return `
      <style>
        .section-locked-page{display:grid;grid-template-columns:56px minmax(0,1fr);gap:14px;align-items:center;min-height:150px;padding:20px;background:linear-gradient(135deg,rgba(116,51,68,.055),rgba(255,253,248,.90));border-color:rgba(116,51,68,.17)}
        .section-locked-page>span{width:52px;height:52px;display:grid;place-items:center;border-radius:16px;background:rgba(116,51,68,.09);color:#743344}
        .section-locked-page .ui-icon{width:25px;height:25px}.section-locked-page h3{margin:3px 0 5px;font-size:25px}.section-locked-page p:not(.eyebrow){margin:0;color:var(--muted);font-size:11px}
      </style>
      ${sectionHeader("próximamente", definition.title, "")}
      <section class="section-card section-locked-page">
        <span>${uiIcon("lock")}</span>
        <div>
          <p class="eyebrow">Contenido bloqueado</p>
          <h3>Se habilitará más adelante</h3>
          <p>${escapeHTML(definition.text)}</p>
        </div>
      </section>`;
  }



  const GAME_NOTIFICATION_DEFINITIONS = [
    { key: "trivia-music", title: "La banda sonora", route: "puntos" },
    { key: "trivia-couple", title: "¿Cuánto conocés a los novios?", route: "puntos" },
    { key: "trivia-who", title: "¿Quién es quién?", route: "puntos" }
  ];

  function currentNotificationState() {
    if (!currentGuest?.id) {
      return {
        initialized: false,
        sectionBaselineInitialized: false,
        socialSeenAt: 0,
        seenUnlockKeys: [],
        seenSectionKeys: []
      };
    }

    const existing = state.notificationsByGuest?.[currentGuest.id];

    return {
      initialized: Boolean(existing?.initialized),
      sectionBaselineInitialized: Array.isArray(existing?.seenSectionKeys),
      socialSeenAt: Number(existing?.socialSeenAt || 0),
      seenUnlockKeys: Array.isArray(existing?.seenUnlockKeys)
        ? [...existing.seenUnlockKeys]
        : [],
      seenSectionKeys: Array.isArray(existing?.seenSectionKeys)
        ? [...existing.seenSectionKeys]
        : []
    };
  }

  function saveCurrentNotificationState(record) {
    if (!currentGuest?.id) return;

    const officialRecord = {
      guestId: currentGuest.id,
      initialized: Boolean(record.initialized),
      socialSeenAt: Number(record.socialSeenAt || 0),
      seenUnlockKeys: Array.from(
        new Set(record.seenUnlockKeys || [])
      ),
      seenSectionKeys: Array.from(
        new Set(record.seenSectionKeys || [])
      ),
      updatedAt: new Date().toISOString()
    };

    state.notificationsByGuest = {
      ...(state.notificationsByGuest || {}),
      [currentGuest.id]: officialRecord
    };

    if (
      navigator.onLine === false ||
      !state.remoteReady
    ) return;

    void writeToSheets(
      "saveNotificationState",
      officialRecord
    );
  }

  function latestVisibleSocialTime() {
    return Math.max(
      0,
      ...dedupeSocialMessages(state.socialMessages || [])
        .filter(message => message.guestId !== currentGuest?.id)
        .map(socialMessageTime)
    );
  }

  function currentOpenSectionKeys() {
    return SECTION_DEFINITIONS
      .filter(section => isSectionOpen(section.route))
      .map(section => section.key);
  }

  function initializeCurrentNotifications() {
    if (!currentGuest?.id) return;

    const record = currentNotificationState();

    if (!record.initialized) {
      record.initialized = true;
      record.socialSeenAt = latestVisibleSocialTime();
      record.seenUnlockKeys = GAME_NOTIFICATION_DEFINITIONS
        .filter(game => isTriviaGameOpen(game.key))
        .map(game => game.key);
      record.seenSectionKeys = currentOpenSectionKeys();
      record.sectionBaselineInitialized = true;
      saveCurrentNotificationState(record);
      return;
    }

    if (!record.sectionBaselineInitialized) {
      record.seenSectionKeys = currentOpenSectionKeys();
      record.sectionBaselineInitialized = true;
      saveCurrentNotificationState(record);
    }
  }

  function migrateSectionNotificationBaselineBeforeSync() {
    if (!currentGuest?.id) return;

    const existing = state.notificationsByGuest?.[currentGuest.id];

    if (
      existing?.initialized &&
      !Array.isArray(existing?.seenSectionKeys)
    ) {
      const record = currentNotificationState();
      record.seenSectionKeys = currentOpenSectionKeys();
      record.sectionBaselineInitialized = true;
      saveCurrentNotificationState(record);
    }
  }

  function notificationItems() {
    if (!currentGuest?.id) return [];

    const record = currentNotificationState();
    if (!record.initialized) return [];

    const socialItems = dedupeSocialMessages(state.socialMessages || [])
      .filter(message =>
        message.guestId !== currentGuest.id &&
        socialMessageTime(message) > record.socialSeenAt
      )
      .sort((a, b) => socialMessageTime(b) - socialMessageTime(a))
      .slice(0, 4)
      .map(message => {
        const author = socialAuthor(message);
        return {
          type: "social",
          route: "social",
          key: message.messageId,
          icon: "chat",
          title: message.parentId ? "Nueva respuesta en Social" : "Nuevo mensaje en Social",
          text: `${author.name}: ${socialMessageExcerpt(message.message, 72)}`
        };
      });

    const gameItems = GAME_NOTIFICATION_DEFINITIONS
      .filter(game =>
        isTriviaGameOpen(game.key) &&
        !record.seenUnlockKeys.includes(game.key)
      )
      .map(game => ({
        type: "game",
        route: game.route,
        key: game.key,
        icon: "star",
        title: "Nuevo juego desbloqueado",
        text: game.title
      }));

    const sectionItems = SECTION_DEFINITIONS
      .filter(section =>
        isSectionOpen(section.route) &&
        !record.seenSectionKeys.includes(section.key)
      )
      .map(section => ({
        type: "section",
        route: section.route === "invitados"
          ? "equipo"
          : section.route,
        tab: section.route === "invitados"
          ? "all"
          : "",
        key: section.key,
        icon: "sparkle",
        title: "Nueva sección disponible",
        text: section.title
      }));

    return [...sectionItems, ...gameItems, ...socialItems];
  }

  function markNotificationsForRoute(route) {
    if (!currentGuest?.id) return;

    const record = currentNotificationState();
    if (!record.initialized) return;

    let changed = false;

    if (route === "social") {
      const latest = latestVisibleSocialTime();
      if (latest > record.socialSeenAt) {
        record.socialSeenAt = latest;
        changed = true;
      }
    }

    if (["puntos", "trivia"].includes(route)) {
      const openKeys = GAME_NOTIFICATION_DEFINITIONS
        .filter(game => isTriviaGameOpen(game.key))
        .map(game => game.key);
      const nextKeys = Array.from(
        new Set([...record.seenUnlockKeys, ...openKeys])
      );
      if (nextKeys.length !== record.seenUnlockKeys.length) {
        record.seenUnlockKeys = nextKeys;
        changed = true;
      }
    }

    const sectionRoute =
      route === "admin"
        ? ""
        : route === "invitados"
          ? "invitados"
          : route === "equipo" && teamCommunityTab === "all"
            ? "invitados"
            : route;
    const section = sectionRoute
      ? sectionDefinition(sectionRoute)
      : null;

    if (
      section &&
      isSectionOpen(section.route) &&
      !record.seenSectionKeys.includes(section.key)
    ) {
      record.seenSectionKeys = Array.from(
        new Set([...record.seenSectionKeys, section.key])
      );
      changed = true;
    }

    if (changed) saveCurrentNotificationState(record);
  }

  function markSingleNotification(type, key) {
    if (!currentGuest?.id) return;

    const record = currentNotificationState();
    if (!record.initialized) return;

    if (type === "social") {
      record.socialSeenAt = Math.max(
        record.socialSeenAt,
        latestVisibleSocialTime()
      );
    } else if (type === "game" && key) {
      record.seenUnlockKeys = Array.from(
        new Set([...record.seenUnlockKeys, key])
      );
    } else if (type === "section" && key) {
      record.seenSectionKeys = Array.from(
        new Set([...record.seenSectionKeys, key])
      );
    }

    saveCurrentNotificationState(record);
  }

  function setNotificationPanelOpen(open) {
    const panel = $("#notificationPanel");
    const button = $("#notificationButton");
    if (!panel || !button) return;

    panel.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    button.classList.toggle("is-open", open);
  }

  function updateNotificationUi() {
    const list = $("#notificationList");
    const badge = $("#notificationBadge");
    if (!list || !badge) return;

    const items = notificationItems();
    const count = items.length;

    badge.textContent = count > 9 ? "9+" : String(count);
    badge.classList.toggle("hidden", !count);

    list.innerHTML = count
      ? items.map(item => `
          <button
            type="button"
            class="notification-item"
            data-notification-type="${escapeHTML(item.type)}"
            data-notification-key="${escapeHTML(item.key || "")}"
            data-notification-tab="${escapeHTML(item.tab || "")}"
            data-notification-route="${escapeHTML(item.route)}">
            <span>${uiIcon(item.icon)}</span>
            <div>
              <strong>${escapeHTML(item.title)}</strong>
              <small>${escapeHTML(item.text)}</small>
            </div>
            <b aria-hidden="true">›</b>
          </button>
        `).join("")
      : `
        <div class="notification-empty">
          ${uiIcon("checkCircle")}
          <strong>Estás al día</strong>
          <small>No hay novedades pendientes.</small>
        </div>`;
  }


  const SAMPLE_COUPLE_QUESTIONS = [
    {
      id: "first-look",
      question: "¿En qué lugar cruzaron miradas por primera vez?",
      options: [
        "En una merienda con amigos.",
        "En el comedor de su primer trabajo.",
        "En un boliche a las 3 de la mañana.",
        "En una plaza tomando unos mates."
      ],
      answer: "En el comedor de su primer trabajo."
    },
    {
      id: "first-date",
      question: "¿Dónde fue la esperada primera cita?",
      options: [
        "En el cine.",
        "En un restaurante elegante.",
        "Tomando una merienda.",
        "En una plaza."
      ],
      answer: "En el cine."
    },
    {
      id: "shared-passion",
      question: "Si pudieran armar las valijas hoy mismo, ¿cuál es la mayor pasión que comparten?",
      options: [
        "Viajar a cualquier rincón del mundo.",
        "Trabajar hasta tarde.",
        "Hacer deporte juntos.",
        "Quedarse jugando juegos de mesa."
      ],
      answer: "Viajar a cualquier rincón del mundo."
    },
    {
      id: "dog",
      question: "¿Cómo se llama el integrante peludo de 4 patas que reina en la casa?",
      options: ["Simba.", "Coco.", "Milo.", "Loki."],
      answer: "Simba."
    },
    {
      id: "years",
      question: "¿Cuántos años de paciencia, amor y aventuras llevan juntos?",
      options: ["9 años.", "10 años.", "11 años.", "12 años."],
      answer: "11 años."
    }
  ];

  const WHO_IS_WHO_QUESTIONS = [
    {
      id: "lost-things",
      question: "¿Quién es más probable que pierda las llaves o el celular?",
      options: ["Vani", "Fede"],
      answer: "Vani"
    },
    {
      id: "movie-sleep",
      question: "¿Quién es el primero en quedarse dormido en medio de una película?",
      options: ["Vani", "Fede"],
      answer: "Fede"
    },
    {
      id: "exercise",
      question: "Termina el día y llega la hora de moverse... ¿Quién es más probable que cumpla con la actividad física por la tarde?",
      options: ["Vani", "Fede"],
      answer: "Vani"
    },
    {
      id: "masterchef",
      question: "¿Quién es el MasterChef oficial de la casa?",
      options: ["Vani", "Fede"],
      answer: "Fede"
    },
    {
      id: "organized",
      question: "¿Quién es la persona más ordenada de la pareja?",
      options: ["Vani", "Fede"],
      answer: "Vani"
    }
  ];


  function isTriviaGameOpen(key) {
    if (Object.prototype.hasOwnProperty.call(state.manualUnlocks || {}, key)) {
      return state.manualUnlocks[key] === true || state.manualUnlocks[key] === "TRUE";
    }
    return Boolean(TRIVIA_GAME_DEFAULTS[key]);
  }

  function triviaSubmission(gameId) {
    return state.gameSubmissions[`${currentGuest.id}::${gameId}`] || null;
  }

  function renderHome() {
    const team = getTeam(currentGuest.team);
    const rsvp = state.rsvps[currentGuest.id];
    const rsvpDone = hasFinalRsvp(rsvp);
    const locationOpen = isSectionOpen("ubicacion");
    const giftsOpen = isTriviaGameOpen("gifts-section");
    const musicDone = Boolean(triviaSubmission("music-selection"));
    const coupleTriviaDone = Boolean(
      triviaSubmission("couple-trivia-test")
    );
    const whoTriviaDone = Boolean(
      triviaSubmission("who-is-who-trivia-test")
    );
    const challengesDone =
      musicDone &&
      coupleTriviaDone &&
      whoTriviaDone;

    const rank = calculateRanking();
    const deadline =
      CONFIG.RSVP_DEADLINE_LABEL ||
      "31 de agosto de 2026";

    const now = new Date();
    const eventDate = new Date(DATA.couple.eventDate);
    const daysToEvent = Math.ceil(
      (eventDate.getTime() - now.getTime()) /
      (24 * 60 * 60 * 1000)
    );
    const eventDay =
      isWeddingDayMode() || (
      now.getFullYear() === eventDate.getFullYear() &&
      now.getMonth() === eventDate.getMonth() &&
      now.getDate() === eventDate.getDate()
      );
    const nearEvent =
      !eventDay &&
      daysToEvent > 0 &&
      daysToEvent <= 30;

    let primaryAction = null;

    if (!rsvpDone) {
      primaryAction = {
        tone: "pending",
        icon: "calendarCheck",
        kicker: "Tu próximo paso",
        title: "Confirmá tu asistencia",
        text: `Respondé antes del ${deadline}.`,
        button: "Confirmar asistencia",
        attr: 'data-go="asistencia"'
      };
    } else if (eventDay) {
      primaryAction = {
        tone: "today",
        icon: "sparkle",
        kicker: "Hoy es el gran día",
        title: "Todo listo para celebrar",
        text: "Revisá la información clave antes de salir.",
        button: "Ver lo esencial",
        attr: 'data-scroll="homeEssential"'
      };
    } else if (nearEvent) {
      primaryAction = {
        tone: "soon",
        icon: "hourglass",
        kicker: "Falta poco",
        title: `${daysToEvent} ${
          daysToEvent === 1 ? "día" : "días"
        } para el casamiento`,
        text: "Revisá horario, traslado y vestimenta.",
        button: "Ver lo esencial",
        attr: 'data-scroll="homeEssential"'
      };
    } else if (!challengesDone) {
      primaryAction = {
        tone: "play",
        icon: "star",
        kicker: "Tu próximo desafío",
        title: "Sumá puntos para tu equipo",
        text: "Revisá las misiones disponibles.",
        button: "Ver desafíos",
        attr: 'data-go="puntos"'
      };
    }

    return `
      ${homeStyles()}
      <section
        id="homeCountdown"
        class="home-countdown-v2"
        aria-label="Cuenta regresiva para el casamiento">
        <div class="home-countdown-copy">
          <span id="countdownLabel">Faltan</span>
        </div>
        <div class="home-countdown-values-v2">
          <span>
            <strong id="countdownDays">—</strong>
            <small>días</small>
          </span>
          <span>
            <strong id="countdownHours">—</strong>
            <small>horas</small>
          </span>
          <span>
            <strong id="countdownMinutes">—</strong>
            <small>min</small>
          </span>
        </div>
      </section>

      <button
        type="button"
        class="home-install-app-banner hidden"
        data-install-app
        aria-label="Instalar la app de Vani y Fede">
        <span class="home-install-app-icon" aria-hidden="true">
          ${uiIcon("download")}
        </span>
        <span class="home-install-app-copy">
          <strong>¡Instalá nuestra APP!</strong>
          <small>Vani &amp; Fede</small>
        </span>
        <span class="home-install-app-arrow" aria-hidden="true">›</span>
      </button>

      ${eventDay ? `
        <section class="wedding-day-command section-card">
          <div class="wedding-day-command-head">
            <span aria-hidden="true">✨</span>
            <div><small>24 de octubre de 2026</small><h3>Hoy es el gran día</h3><p>Todo lo importante para salir y llegar sin vueltas.</p></div>
          </div>
          <div class="wedding-day-command-actions">
            ${locationOpen ? `<button type="button" data-go="ubicacion">${uiIcon("pin")}<span>Cómo llegar</span></button>` : ""}
            <button type="button" data-go="cronograma">${uiIcon("clock")}<span>Cronograma</span></button>
            <button type="button" data-go="traslado">${uiIcon("bus")}<span>Traslado</span></button>
          </div>
        </section>
      ` : ""}

      ${primaryAction ? `
        <section
          class="home-primary-action home-primary-action--${primaryAction.tone}">
          <span class="home-primary-icon">
            ${uiIcon(primaryAction.icon)}
          </span>
          <div class="home-primary-copy">
            <small>${escapeHTML(primaryAction.kicker)}</small>
            <h3>${escapeHTML(primaryAction.title)}</h3>
            <p>${escapeHTML(primaryAction.text)}</p>
          </div>
          <button type="button" ${primaryAction.attr}>
            ${escapeHTML(primaryAction.button)}
          </button>
        </section>
      ` : ""}

      <section
        id="homeEssential"
        class="home-essential"
        aria-labelledby="homeEssentialTitle">
        <div class="home-section-heading">
          <div>
            <p class="home-kicker">Información práctica</p>
            <h3 id="homeEssentialTitle">Lo esencial</h3>
          </div>
        </div>

        <div class="home-essential-card">
          <article class="home-essential-row home-essential-date">
            <span class="home-essential-icon">
              ${uiIcon("calendar")}
            </span>
            <div>
              <small>Fecha</small>
              <strong>Sábado 24 de Octubre</strong>
              <p>18:00 a 03:00</p>
            </div>
          </article>

          ${locationOpen ? `
            <button
              type="button"
              class="home-essential-row home-essential-link home-essential-location"
              data-go="ubicacion">
              <span class="home-essential-icon">
                ${uiIcon("pin")}
              </span>
              <div>
                <small>Lugar</small>
                <strong>Estancia "Los Candiles"</strong>
                <p>Solís, Provincia de Buenos Aires</p>
              </div>
            </button>
          ` : `
            <article
              class="home-essential-row home-essential-location home-essential-location-locked">
              <span class="home-essential-icon">
                ${uiIcon("lock")}
              </span>
              <div>
                <small>Lugar</small>
                <strong>¡Lugar secreto!</strong>
                <p>La ubicación se habilitará más adelante.</p>
              </div>
            </article>
          `}

          <button
            type="button"
            class="home-essential-row home-essential-link home-essential-transport"
            data-go="traslado">
            <span class="home-essential-icon">
              ${uiIcon("bus")}
            </span>
            <div>
              <small>Traslado</small>
              <strong>Micro / Combi</strong>
              <p>Confirmá en la asistencia</p>
            </div>
          </button>

          <article class="home-essential-row home-essential-dress">
            <span class="home-essential-icon">
              ${uiIcon("dress")}
            </span>
            <div>
              <small>Vestimenta</small>
              <strong>Elegante sport</strong>
              <p>
                El lugar tiene mucho césped,
                ¡vení con calzado cómodo!
              </p>
            </div>
          </article>

          <button
            type="button"
            class="home-essential-row home-essential-link home-essential-diet"
            data-go="asistencia">
            <span class="home-essential-icon">
              ${uiIcon("food")}
            </span>
            <div>
              <small>Información importante</small>
              <strong>Restricciones alimentarias</strong>
              <p>Confirmá en la asistencia</p>
            </div>
          </button>
        </div>

        ${giftsOpen ? `
          <button
            type="button"
            class="home-gifts-feature"
            data-go="regalos">
            <span class="home-gifts-feature-icon">
              ${uiIcon("gift")}
            </span>
            <span class="home-gifts-feature-copy">
              <small>Regalos</small>
              <strong>
                Nuestro mejor regalo es tu presencia 🥂
              </strong>
              <em>
                Ver opciones para ayudarnos con nuestra Luna de Miel
              </em>
            </span>
            <b aria-hidden="true">›</b>
          </button>
        ` : ""}
      </section>

      ${(rsvpDone || challengesDone) ? `
        <section
          class="home-completion-status-grid ${
            rsvpDone && challengesDone
              ? "has-two"
              : "has-one"
          }">
          ${rsvpDone ? `
            <button
              class="home-rsvp-confirmed home-completion-status"
              type="button"
              data-go="asistencia">
              ${uiIcon("checkCircle")}
              <span>
                ${
                  rsvp.attendance === "si"
                    ? "Asistencia confirmada"
                    : "Respuesta guardada"
                }
              </span>
            </button>
          ` : ""}

          ${challengesDone ? `
            <button
              class="home-rsvp-confirmed home-completion-status home-challenges-confirmed"
              type="button"
              data-go="puntos">
              ${uiIcon("checkCircle")}
              <span>Desafíos completados</span>
            </button>
          ` : ""}
        </section>
      ` : ""}

      ${challengesDone ? `
        <div class="home-more-challenges-note">
          <span aria-hidden="true">🕒</span>
          <strong>¡Próximamente llegarán más desafíos!</strong>
        </div>
      ` : ""}
    `;
  }


  function homeStyles() {
    return `<style>
      .home-kicker{margin:0;color:var(--gold-deep);font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase}
      .home-countdown-v2{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(0,1.3fr);gap:14px;align-items:center;padding:14px 16px;border:1px solid rgba(201,170,114,.32);border-radius:22px;background:linear-gradient(135deg,rgba(255,253,248,.96),rgba(239,228,209,.78));box-shadow:0 10px 24px rgba(76,51,22,.06)}
      .home-countdown-copy{padding-right:14px;border-right:1px solid rgba(132,104,68,.16)}.home-countdown-copy span,.home-countdown-copy strong{display:block}.home-countdown-copy span{color:#743344;font-size:10px;font-weight:950;letter-spacing:.18em;text-transform:uppercase}.home-countdown-copy strong{margin-top:4px;color:var(--ink);font-family:var(--font-title);font-size:19px;letter-spacing:.04em}
      .home-countdown-values-v2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.home-countdown-values-v2>span{display:grid;place-items:center;min-height:58px;padding:6px;border:1px solid rgba(132,104,68,.12);border-radius:15px;background:rgba(255,255,255,.45)}.home-countdown-values-v2 strong{font-family:var(--font-title);font-size:27px;line-height:1;color:#243954}.home-countdown-values-v2 small{margin-top:2px;color:var(--muted);font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .home-welcome-compact{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(135deg,rgba(255,253,248,.94),rgba(239,228,209,.72));box-shadow:0 7px 18px rgba(76,51,22,.05)}.home-welcome-compact .home-team-logo{width:43px;height:43px;flex:0 0 auto}.home-welcome-compact h3{font-size:clamp(19px,4vw,27px);line-height:1.08}
      .home-rsvp-confirmed{width:max-content;display:flex;align-items:center;gap:6px;margin:7px 0 0;padding:6px 9px;border:1px solid rgba(74,125,79,.2);border-radius:999px;background:rgba(74,125,79,.08);color:#426f47;box-shadow:none;font-size:11px;font-weight:900}.home-rsvp-confirmed .ui-icon{width:15px;height:15px}
      .home-primary-action{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px;align-items:center;margin-top:8px;padding:12px 13px;border:1px solid rgba(183,137,69,.25);border-radius:17px;background:rgba(255,253,248,.84);box-shadow:0 6px 16px rgba(76,51,22,.04)}.home-primary-icon{width:37px;height:37px;display:grid;place-items:center;border-radius:12px;background:rgba(122,49,64,.08);color:#743344}.home-primary-icon .ui-icon{width:19px;height:19px}.home-primary-copy small{color:var(--gold-deep);font-size:8px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.home-primary-copy h3{margin:1px 0 2px;font-size:18px}.home-primary-copy p{margin:0;font-size:11px;line-height:1.3}.home-primary-action button{min-height:36px;padding:8px 12px;white-space:nowrap}
      .home-essential{margin-top:15px;scroll-margin-top:82px}.home-section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.home-section-heading h3{margin:1px 0 0;font-size:24px}.home-calendar-link{min-height:33px;display:inline-flex;align-items:center;gap:5px;padding:6px 9px;border:1px solid var(--line);border-radius:999px;background:rgba(255,253,248,.72);color:var(--ink);font-size:10px;font-weight:850;text-decoration:none}.home-calendar-link .ui-icon{width:15px;height:15px}
      .home-essential-card{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));overflow:hidden;border:1px solid var(--line);border-radius:18px;background:rgba(255,253,248,.76)}.home-essential-row{display:grid;grid-template-columns:30px minmax(0,1fr);gap:7px;align-items:start;padding:10px 9px;border-right:1px solid var(--line)}.home-essential-row:last-child{border-right:0}.home-essential-icon{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;background:rgba(201,170,114,.12);color:var(--gold-deep)}.home-essential-icon .ui-icon{width:16px;height:16px}.home-essential-row small,.home-essential-row strong{display:block}.home-essential-row small{font-size:8px;text-transform:uppercase;letter-spacing:.06em}.home-essential-row strong{margin:1px 0;font-size:12px;line-height:1.17}.home-essential-row p{margin:0;font-size:9.5px;line-height:1.25}
      .home-team-mini{display:grid;grid-template-columns:34px minmax(0,1fr) auto auto 32px;gap:7px;align-items:center;margin-top:9px;padding:7px 9px;border:1px solid var(--line);border-radius:14px;background:rgba(255,253,248,.78)}.home-team-mini-logo{width:32px;height:32px}.home-team-mini-name small,.home-team-mini-name strong,.home-team-mini-stat small,.home-team-mini-stat b{display:block}.home-team-mini-name small,.home-team-mini-stat small{font-size:7px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.home-team-mini-name strong{font-size:13px}.home-team-mini-stat{text-align:center;min-width:31px}.home-team-mini-stat b{font-size:14px}.home-team-mini button{width:30px;height:30px;display:grid;place-items:center;padding:0;border-radius:9px;background:#36556f;color:#fff}.home-team-mini button .ui-icon{width:16px;height:16px}
      @media(max-width:900px){.home-essential-card{grid-template-columns:repeat(2,minmax(0,1fr))}.home-essential-row{border-bottom:1px solid var(--line)}.home-essential-row:nth-child(2n){border-right:0}.home-essential-row:last-child{grid-column:1/-1;border-bottom:0}}
      @media(max-width:560px){.home-countdown-v2{grid-template-columns:95px minmax(0,1fr);gap:10px;padding:11px 12px}.home-countdown-copy{padding-right:9px}.home-countdown-copy strong{font-size:15px}.home-countdown-values-v2{gap:5px}.home-countdown-values-v2>span{min-height:49px;border-radius:12px}.home-countdown-values-v2 strong{font-size:23px}.home-welcome-compact{padding:9px 11px}.home-welcome-compact .home-team-logo{width:38px;height:38px}.home-welcome-compact h3{font-size:18px}.home-primary-action{grid-template-columns:34px minmax(0,1fr);padding:10px}.home-primary-icon{width:34px;height:34px}.home-primary-copy h3{font-size:16px}.home-primary-action button{grid-column:1/-1;width:100%;min-height:36px}.home-essential{margin-top:13px}.home-section-heading h3{font-size:21px}.home-essential-card{grid-template-columns:1fr}.home-essential-row,.home-essential-row:nth-child(2n),.home-essential-row:last-child{grid-column:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 10px}.home-essential-row:last-child{border-bottom:0}.home-team-mini{grid-template-columns:31px minmax(0,1fr) auto auto 29px;padding:6px 8px;gap:5px}.home-team-mini-logo{width:29px;height:29px}.home-team-mini-name strong{font-size:12px}.home-team-mini-stat{min-width:28px}.home-team-mini-stat b{font-size:13px}.home-team-mini button{width:28px;height:28px}}
    </style>`;
  }

  function renderInfo() {
    const locationOpen = isUnlocked("location");
    const menuOpen = isUnlocked("menu");

    return `
      ${infoStyles()}
      ${sectionHeader("info terrenal", "Todo lo que necesitás saber", "La información útil para llegar al bosque sin perderte en el intento. El destino final sigue siendo secreto.")}

      <section class="info-hero section-card">
        <div>
          <p class="eyebrow">24 · 10 · 2026</p>
          <h3>De 18:00 a 03:00 hs</h3>
          <p>Una noche larga, misteriosa y con regreso organizado. Vos solo ocupate de venir con ganas de celebrar.</p>
          <div class="badge-row">
            <span class="badge">📅 Sábado 24 de octubre</span>
            <span class="badge muted">🕕 18:00 a 03:00</span>
            <span class="badge muted">📍 Lugar secreto</span>
          </div>
        </div>

      </section>

      <section class="grid two info-main-grid">
        <article class="section-card major ${locationOpen ? "" : "locked-panel"}">
          <span class="card-icon">${locationOpen ? "📍" : "🔒"}</span>
          <h4>${locationOpen ? DATA.couple.placeName : "Lugar secreto"}</h4>
          <p>${locationOpen ? `${DATA.couple.placeArea}. Dirección exacta y mapa listos para compartir.` : "El destino final será revelado más adelante. Por ahora solo necesitás saber que el bosque queda lejos, pero el viaje está contemplado."}</p>
          <small>${locationOpen ? "Archivo abierto" : "El mapa se abrirá más cerca de la fecha."}</small>
        </article>

        <article class="section-card major micro-card">
          <span class="card-icon">🚌</span>
          <h4>Micro misterioso</h4>
          <p><strong>Relax, no te preocupes por cómo ir ni cómo volver.</strong></p>
          <p>Vamos a disponer un micro que saldrá desde el <strong>Obelisco</strong> y llevará a los invitados hasta el lugar secreto.</p>
          <div class="micro-steps"><span>Subís en el Obelisco</span><span>→</span><span>Bajás en el bosque</span></div>
          <p>Regreso previsto: <strong>03:00 hs</strong>.</p>
          <small>Si querés recibir información del micro, marcá “Necesito información del micro” al confirmar asistencia.</small>
        </article>
      </section>

      <section class="section-card info-battle-card">
        <span class="card-icon">🏆</span>
        <h4>La batalla ya empezó</h4>
        <p>Vas a competir contra otros 5 equipos desde ahora mismo hasta que finalice la fiesta. En la sección <strong>Sumá puntos!</strong> vas a ver juegos, reglas y formas de sumar para tu equipo.</p>
        <button type="button" data-go="puntos">Ver cómo sumar puntos</button>
      </section>

      <section class="section-card dress-card">
        <div class="card-title-row"><div><span class="card-icon">🖤</span><h4>Código de vestimenta</h4></div><span class="badge">Elegante festivo de estancia</span></div>
        <p class="dress-lead">Venite arreglado/a, cómodo/a y listo/a para una noche larga de fiesta.</p>
        <div class="grid two compact">
          <div class="menu-line"><strong>Para ellas</strong><p>Vestidos, monos, conjuntos o looks elegantes. Importante: habrá sectores con pasto. Mejor taco ancho, plataforma, botas elegantes o calzado cómodo para jardín.</p></div>
          <div class="menu-line"><strong>Para ellos</strong><p>Traje, saco, camisa o look elegante de fiesta. Corbata opcional.</p></div>
        </div>
        <div class="warning-ribbon">Evitá tacos aguja o tacos muy finos. Queremos que estés divino/a, pero también que puedas bailar, caminar y sobrevivir al bosque.</div>
        <p class="form-note">Evitar blanco total.</p>
      </section>

      <section class="grid two">
        <article class="section-card"><span class="card-icon">🌿</span><h4>Consejo del bosque</h4><p>Puede refrescar de noche. Traé un abrigo liviano y elegí calzado cómodo.</p><p>Y si venís en el micro misterioso, dejate llevar.</p></article>
        <article class="section-card ${menuOpen ? "" : "locked-panel"}"><div class="card-title-row"><h4>🍽️ Menú</h4><span class="badge">${menuOpen ? "Disponible" : "Bloqueado"}</span></div>${menuOpen ? `<div class="grid two compact">${Object.entries(DATA.info.menu).map(([key, value]) => `<div class="menu-line"><strong>${menuLabel(key)}</strong><p>${escapeHTML(value)}</p></div>`).join("")}</div>` : `<p>Se revelará más adelante.</p><p>Si tenés restricciones alimentarias, alergias o preferencias importantes, cargalas en <strong>Confirmar asistencia</strong>.</p>`}</article>
      </section>

      <section class="section-card"><div class="card-title-row"><h4>Preguntas rápidas</h4><span class="badge muted">FAQ</span></div><div class="faq-grid"><div><strong>¿Dónde es?</strong><p>Todavía es secreto. El destino final se revelará más adelante.</p></div><div><strong>¿Hay micro?</strong><p>Sí. Saldrá desde el Obelisco y volverá al finalizar la fiesta.</p></div><div><strong>¿A qué hora es?</strong><p>El evento es de 18:00 a 03:00 hs.</p></div><div><strong>¿Qué calzado conviene?</strong><p>Algo elegante, pero cómodo para caminar sobre pasto.</p></div></div></section>`;
  }

  function renderTransport() {
    return `
      ${transportStyles()}
      ${sectionHeader("casamiento", "Traslados", "Elegí cómo querés llegar a la celebración.")}

      <section class="transport-experience section-card">
        <span class="transport-experience-icon">${uiIcon("bus")}</span>
        <div>
          <p class="eyebrow">Experiencia completa</p>
          <h3>¡Te recomendamos viajar en micro!</h3>
          <p>Además de viajar cómodo y seguro, vas a poder participar de las consignas del recorrido y sumar <strong>20 puntos extra</strong> para tu equipo.</p>
          <button type="button" data-go="asistencia">Elegir micro en Asistencia</button>
        </div>
      </section>

      <section class="transport-options-grid">
        <article class="section-card transport-option-card">
          <span>${uiIcon("car")}</span>
          <div>
            <small>Viaje particular</small>
            <strong>La ubicación se habilitará el día de la boda</strong>
            <p>Ese día vas a encontrar la locación y las indicaciones necesarias dentro de la aplicación.</p>
          </div>
        </article>

        <article class="section-card transport-option-card transport-stay-card">
          <span>${uiIcon("pin")}</span>
          <div>
            <small>Alojamiento</small>
            <strong>¿Te interesa hospedarte por la zona?</strong>
            <p>Contactá a los novios cuando quieras y te orientamos con opciones cercanas.</p>
          </div>
        </article>
      </section>`;
  }


  function transportStyles() {
    return `<style>
      .transport-hero{display:grid;grid-template-columns:75px minmax(0,1fr);gap:15px;align-items:center;padding:17px;background:linear-gradient(135deg,rgba(201,170,114,.12),rgba(255,253,248,.90))}.transport-illustration{width:68px;height:68px;display:grid;place-items:center;border:1px solid rgba(116,51,68,.16);border-radius:20px;background:rgba(116,51,68,.06);color:#743344}.transport-illustration .ui-icon{width:34px;height:34px}.transport-status{display:inline-flex;padding:4px 8px;border-radius:999px;background:rgba(201,170,114,.14);color:var(--gold-deep);font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.transport-copy h3{margin:5px 0 4px;font-size:clamp(22px,4vw,32px)}.transport-copy p{margin:0;font-size:12px;line-height:1.35}.transport-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.transport-grid article{display:grid;grid-template-columns:35px minmax(0,1fr);gap:9px;padding:12px}.transport-grid article>span{width:33px;height:33px;display:grid;place-items:center;border-radius:10px;background:rgba(201,170,114,.13);color:#8a6129}.transport-grid .ui-icon{width:18px;height:18px}.transport-grid small,.transport-grid strong{display:block}.transport-grid strong{margin:2px 0 3px;font-size:16px}.transport-grid p{margin:0;font-size:10px}.transport-preview{display:flex;align-items:center;gap:10px;padding:13px;border-style:solid}.transport-preview>div:first-child{width:37px;height:37px;display:grid;place-items:center;border-radius:11px;background:rgba(132,104,68,.08)}.transport-preview strong{display:block}.transport-preview p{margin:2px 0 0;font-size:11px}
      @media(max-width:650px){.transport-hero{grid-template-columns:58px minmax(0,1fr);padding:14px}.transport-illustration{width:54px;height:54px;border-radius:16px}.transport-illustration .ui-icon{width:28px;height:28px}.transport-grid{grid-template-columns:1fr}.transport-grid article{padding:10px}}
    </style>`;
  }


  function infoStyles() {
    return `<style>
      .info-hero{display:flex;align-items:center;justify-content:space-between;gap:22px;background:linear-gradient(135deg,rgba(216,185,106,.14),rgba(24,39,25,.82));border-color:rgba(216,185,106,.38)}
      .info-hero h3{font-size:38px;margin:4px 0 10px;line-height:1}
      .info-hero p{max-width:720px}
      .info-calendar-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;border-radius:999px;padding:15px 22px;font-weight:900;background:linear-gradient(135deg,#f0cd75,#cda34d);color:#1b1304;white-space:nowrap;border:1px solid rgba(255,255,255,.12)}
      .info-main-grid{margin-top:16px}.micro-card{border-color:rgba(216,185,106,.36)}
      .micro-steps{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0;padding:12px 14px;border-radius:18px;background:rgba(4,9,5,.34);border:1px solid rgba(247,238,217,.14);font-weight:900;color:#f7eed9}
      .dress-card{margin-top:16px}.dress-card .card-title-row{align-items:flex-start}.dress-lead{font-weight:800;color:rgba(247,238,217,.82)}
      .faq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.faq-grid div{border:1px solid rgba(247,238,217,.12);border-radius:18px;padding:14px;background:rgba(4,9,5,.22)}.faq-grid p{margin:7px 0 0;color:rgba(247,238,217,.66);font-weight:750;line-height:1.45}
      .info-battle-card{margin-top:16px;border-color:rgba(216,185,106,.46);background:linear-gradient(135deg,rgba(216,185,106,.16),rgba(24,39,25,.84))}.info-battle-card button{margin-top:14px}
      @media(max-width:760px){.info-hero{flex-direction:column;align-items:flex-start}.info-calendar-button{width:100%}.faq-grid{grid-template-columns:1fr}}
    </style>`;
  }

  function menuLabel(key) {
    return ({ reception: "Recepción", main: "Principal", veggie: "Especiales", dessert: "Postre", lateNight: "Trasnoche" })[key] || key;
  }

  function renderRSVP() {
    const saved = state.rsvps[currentGuest.id] || {};
    const hasSaved = Boolean(saved && saved.updatedAt);
    const hasFinalSaved = hasCompletedRsvp(saved);
    const editing = Boolean(state.rsvpEditMode || !hasSaved || !hasFinalSaved);
    const deadlineLabel = "31 de agosto de 2026";
    const savedTransport = ["combi", "micro"].includes(saved.transport)
      ? "combi"
      : saved.transport === "auto"
        ? "particular"
        : saved.transport;
    const savedDietChoice = saved.dietChoice ||
      (hasSaved ? (String(saved.diet || "").trim() ? "si" : "no") : "");
    const challengesDone = Boolean(
      triviaSubmission("music-selection") &&
      triviaSubmission("couple-trivia-test") &&
      triviaSubmission("who-is-who-trivia-test")
    );

    if (hasSaved && hasFinalSaved && !editing) {
      return `
        ${rsvpStyles()}
        ${sectionHeader("confirmación", "Asistencia confirmada", "")}
        <section class="section-card rsvp-confirmed-compact">
          <div class="rsvp-confirmed-head">
            <span class="rsvp-okmark">✓</span>
            <div><h4>${saved.pendingSync ? "Guardando respuesta…" : "Respuesta guardada"}</h4><p>${saved.pendingSync ? "Ya la ves actualizada. La confirmación continúa en segundo plano." : "Podés actualizarla cuando lo necesites."}</p></div>
          </div>
          <div class="rsvp-summary-grid">
            ${summaryLine("Asistencia", attendanceLabel(saved.attendance))}
            ${summaryLine("Traslado / micro", transportLabel(saved.transport))}
            ${summaryLine(
              "Restricciones",
              saved.dietChoice === "no" || !String(saved.diet || "").trim()
                ? "No"
                : saved.diet
            )}
          </div>
          <div class="rsvp-actions-row">
            <button id="editRsvp" type="button">Editar respuesta</button>
          </div>
        </section>

        ${challengesDone ? "" : `
          <section class="rsvp-next-challenge section-card">
            <div class="rsvp-next-icon">${uiIcon("star")}</div>
            <div>
              <h4>Ya podés participar</h4>
              <p>Las canciones, la trivia y las próximas misiones están disponibles.</p>
            </div>
            <button type="button" data-go="puntos">Ver desafíos</button>
          </section>
        `}

        <section class="rsvp-related-links rsvp-related-links-single">
          <button
            type="button"
            class="rsvp-related-card section-card"
            data-go="traslado">
            <span>${uiIcon("bus")}</span>
            <div>
              <strong>Traslados</strong>
              <small>Consultá la información del servicio.</small>
            </div>
            <b aria-hidden="true">›</b>
          </button>
        </section>`;
    }

    return `
      ${rsvpStyles()}
      ${sectionHeader("confirmación", hasSaved ? "Editar asistencia" : "Confirmar asistencia", `Responder antes del ${deadlineLabel}.`)}
      <form id="rsvpForm" class="section-card form-card rsvp-form-compact">
        ${hasSaved ? `<div class="warning-ribbon">Completá una respuesta definitiva por sí o por no.</div>` : ""}
        <div class="form-grid">
          ${field("firstName", "Nombre", saved.firstName || currentGuest.firstName, "text", true)}
          ${field("lastName", "Apellido", saved.lastName || currentGuest.lastName, "text", true)}
          ${field("email", "Mail", saved.email || currentGuest.email || "", "email", true)}
          ${field("phone", "Teléfono", saved.phone || "", "tel", false)}

          <fieldset class="choice-field attendance-choice-field">
            <legend>Confirmo asistencia</legend>
            <div class="choice-group choice-group-two">
              ${choicePill("attendance", "si", "Sí, voy!", saved.attendance, true)}
              ${choicePill("attendance", "no", "No podré asistir", saved.attendance, true)}
            </div>
          </fieldset>

          <fieldset class="choice-field transport-choice-field">
            <legend>Traslado</legend>
            <div class="choice-group choice-group-two">
              ${choicePillIcon("transport", "particular", "Particular", "car", savedTransport, true)}
              ${choicePillIcon("transport", "combi", "Micro / Combi", "bus", savedTransport, true)}
            </div>
          </fieldset>

          <fieldset class="choice-field diet-choice-field">
            <legend>¿Tenés restricciones alimentarias?</legend>
            <div class="choice-group choice-group-two">
              ${choicePill("dietChoice", "si", "Sí", savedDietChoice, true)}
              ${choicePill("dietChoice", "no", "No", savedDietChoice, true)}
            </div>
          </fieldset>
        </div>

        <label class="diet-detail-label ${savedDietChoice === "no" ? "is-disabled" : ""}" data-diet-detail>
          <span>Detalle de restricciones / alergias</span>
          <textarea
            name="diet"
            placeholder="Ej: vegetariano, celíaco, sin lactosa..."
            ${savedDietChoice === "no" ? "disabled" : ""}
            ${savedDietChoice === "si" ? "required" : ""}
          >${escapeHTML(saved.diet || "")}</textarea>
          <small>${savedDietChoice === "no" ? "No es necesario completar este campo." : "Completalo únicamente si marcaste Sí."}</small>
        </label>

        <div class="form-actions rsvp-form-actions">
          <button type="submit">${hasSaved ? "Guardar cambios" : "Guardar asistencia"}</button>
          ${hasSaved && hasFinalSaved ? `<button id="cancelRsvpEdit" type="button" class="ghost-button">Cancelar</button>` : ""}
        </div>
      </form>`;
  }


  function rsvpStyles() {
    return `<style>
      .rsvp-form-compact{padding:16px}.rsvp-form-compact .form-grid{gap:10px}.rsvp-form-compact label{gap:5px}.rsvp-form-compact input,.rsvp-form-compact select{min-height:42px}.rsvp-form-compact textarea{min-height:70px}
      .choice-field{border:0;padding:0;margin:0}.choice-field legend{color:var(--ink);font-size:12px;font-weight:900;margin:0 0 7px}.choice-group{display:grid;gap:7px}.choice-group-two{grid-template-columns:repeat(2,minmax(0,1fr))}
      .choice-pill{cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center;min-height:42px;border-radius:999px;border:1px solid rgba(132,104,68,.22);background:rgba(255,255,255,.55);color:var(--ink);font-size:12px;font-weight:900;text-align:center;padding:9px}.choice-pill input{position:absolute;opacity:0;pointer-events:none}.choice-pill:has(input:checked){background:#743344;color:#fffaf0;border-color:#743344;box-shadow:0 0 0 3px rgba(116,51,68,.10)}
      .diet-detail-label{display:grid;gap:5px;margin-top:10px;padding:11px;border:1px solid rgba(132,104,68,.14);border-radius:14px;background:rgba(255,255,255,.35);transition:.18s}.diet-detail-label>span{font-size:12px;font-weight:900}.diet-detail-label small{color:var(--muted);font-size:9px}.diet-detail-label.is-disabled{background:rgba(120,120,120,.055);border-color:rgba(120,120,120,.13)}.diet-detail-label.is-disabled>span,.diet-detail-label.is-disabled small{color:#8b8782}.diet-detail-label textarea:disabled{background:rgba(120,120,120,.08)!important;color:#999!important;cursor:not-allowed}
      .rsvp-confirmed-compact{padding:16px;background:linear-gradient(180deg,rgba(255,253,248,.94),rgba(239,228,209,.80))}.rsvp-confirmed-head{display:flex;align-items:center;gap:11px}.rsvp-confirmed-head h4{margin:0 0 2px;font-size:20px}.rsvp-confirmed-head p{margin:0;font-size:11px}.rsvp-okmark{width:40px;height:40px;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;background:rgba(74,125,79,.10);border:1px solid rgba(74,125,79,.28);color:#426f47;font-size:21px;font-weight:1000}
      .rsvp-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.summary-item{border:1px solid rgba(132,104,68,.14);border-radius:13px;padding:10px;background:rgba(255,255,255,.44)}.summary-item strong{display:block;color:#7a3140;font-size:8px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}.summary-item p{margin:0;color:var(--ink);font-size:12px;font-weight:750;word-break:break-word}
      .rsvp-actions-row,.rsvp-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.rsvp-actions-row button,.rsvp-form-actions button{min-height:37px;padding:8px 12px}
      .rsvp-calendar-link{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:37px;padding:8px 12px;border:1px solid rgba(54,85,111,.25);border-radius:999px;background:rgba(54,85,111,.07);color:#36556f!important;text-decoration:none;font-size:10px;font-weight:900;box-shadow:none}.rsvp-calendar-link .ui-icon{width:15px;height:15px}.rsvp-calendar-link-small{margin-left:auto}
      .rsvp-next-challenge{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center;margin-top:9px;padding:12px 14px;border-color:rgba(201,170,114,.35);background:linear-gradient(135deg,rgba(201,170,114,.10),rgba(255,253,248,.86))}.rsvp-next-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:rgba(201,170,114,.15);color:#9a6e2f}.rsvp-next-icon .ui-icon{width:19px;height:19px}.rsvp-next-challenge h4{margin:0 0 2px;font-size:17px}.rsvp-next-challenge p{margin:0;font-size:10px}.rsvp-next-challenge button{min-height:36px;padding:8px 11px;white-space:nowrap}
      @media(max-width:650px){.rsvp-summary-grid{grid-template-columns:1fr}.rsvp-calendar-link-small{margin-left:0}.rsvp-form-actions>*{width:100%}.rsvp-next-challenge{grid-template-columns:38px minmax(0,1fr)}.rsvp-next-challenge button{grid-column:1/-1;width:100%}}
    </style>`;
  }


  function choicePill(name, value, label, selected, required = false) {
    return `<label class="choice-pill"><input type="radio" name="${escapeHTML(name)}" value="${escapeHTML(value)}" ${value === selected ? "checked" : ""} ${required ? "required" : ""}><span>${escapeHTML(label)}</span></label>`;
  }


  function choicePillIcon(
    name,
    value,
    label,
    icon,
    selected,
    required = false
  ) {
    return `
      <label class="choice-pill choice-pill-with-icon">
        <input
          type="radio"
          name="${escapeHTML(name)}"
          value="${escapeHTML(value)}"
          ${value === selected ? "checked" : ""}
          ${required ? "required" : ""}>
        <span>
          <i>${uiIcon(icon)}</i>
          <b>${escapeHTML(label)}</b>
        </span>
      </label>`;
  }

  function summaryLine(label, value, wide = false) {
    return `<div class="summary-item ${wide ? "wide" : ""}"><strong>${escapeHTML(label)}</strong><p>${escapeHTML(value || "Sin cargar")}</p></div>`;
  }



  function hasCompletedRsvp(row) {
    return Boolean(row && row.updatedAt && ["si", "no"].includes(row.attendance));
  }

  function hasFinalRsvp(row) {
    return hasCompletedRsvp(row);
  }

  function hasCompletedProfile(row) {
    return Boolean(row && row.updatedAt);
  }

  function automaticPointEntries() {
    const entries = [];

    Object.values(DATA.teams).forEach(team => {
      const rsvpPoints = rsvpPointsForTeam(team.id);

      completedRsvpMembers(team.id).forEach(guest => {
        const row = state.rsvps[guest.id] || {};
        entries.push({
          timestamp: row.updatedAt,
          gameId: "auto-rsvp",
          teamId: team.id,
          points: rsvpPoints,
          comment: `Confirmación de asistencia · ${guest.firstName || guest.id}`,
          automatic: true
        });

        if (
          row.attendance === "si" &&
          ["combi", "micro"].includes(row.transport)
        ) {
          entries.push({
            timestamp: row.updatedAt,
            gameId: "auto-micro-transport",
            teamId: team.id,
            points: 20,
            comment: `Bonus por viajar en micro · ${guest.firstName || guest.id}`,
            automatic: true
          });
        }
      });
    });

    Object.values(state.gameSubmissions || {}).forEach(submission => {
      if (!submission || submission.resetMarker || !submission.teamId) return;

      if (submission.gameId === "music-selection") {
        const guest = getGuestById(submission.guestId);
        entries.push({
          timestamp: submission.updatedAt,
          gameId: "auto-music-selection",
          teamId: submission.teamId,
          points: rsvpPointsForTeam(submission.teamId),
          comment: `Juego musical completado · ${guest?.firstName || submission.guestId || "Invitado"}`,
          automatic: true
        });
      }

      if (submission.gameId === "couple-trivia-test") {
        const bestScore = Math.max(
          0,
          Math.min(
            SAMPLE_COUPLE_QUESTIONS.length,
            Number(submission.bestScore ?? submission.score ?? 0)
          )
        );
        const guest = getGuestById(submission.guestId);
        entries.push({
          timestamp: submission.updatedAt,
          gameId: "auto-couple-trivia",
          teamId: submission.teamId,
          points: bestScore * 20,
          comment: `Trivia Vani y Fede completada · ${guest?.firstName || submission.guestId || "Invitado"} · ${bestScore * 20} puntos`,
          automatic: true
        });
      }
      if (submission.gameId === "who-is-who-trivia-test") {
        const bestScore = Math.max(
          0,
          Math.min(
            WHO_IS_WHO_QUESTIONS.length,
            Number(submission.bestScore ?? submission.score ?? 0)
          )
        );
        const guest = getGuestById(submission.guestId);
        entries.push({
          timestamp: submission.updatedAt,
          gameId: "auto-who-is-who-trivia",
          teamId: submission.teamId,
          points: bestScore * 20,
          comment: `Trivia Vani o Fede completada · ${guest?.firstName || submission.guestId || "Invitado"} · ${bestScore * 20} puntos`,
          automatic: true
        });
      }

    });

    return entries;
  }

  function entryTime(entry) {
    return new Date(entry?.timestamp || entry?.submittedAt || entry?.updatedAt || 0).getTime() || 0;
  }

  function isResetMarker(entry) {
    return [
      "reset-discretionary-clear-marker",
      "reset-total-clear-marker",
      "reset-discrecional-fede-vani",
      "reset-total-fede-vani"
    ].includes(entry?.gameId);
  }

  function latestResetAt(gameIds) {
    const ids = Array.isArray(gameIds) ? gameIds : [gameIds];
    return Math.max(0, ...(state.scoreEntries || [])
      .filter(entry => ids.includes(entry.gameId))
      .map(entryTime));
  }

  function allPointEntries() {
    const totalResetAt = latestResetAt(["reset-total-clear-marker", "reset-total-fede-vani"]);
    const discretionaryResetAt = latestResetAt(["reset-discretionary-clear-marker", "reset-discrecional-fede-vani"]);

    return [...automaticPointEntries(), ...(state.scoreEntries || [])]
      .filter(entry => {
        const time = entryTime(entry);
        if (isResetMarker(entry)) return false;
        if (totalResetAt && time <= totalResetAt) return false;
        if (entry.gameId === "discrecional-fede-vani" && discretionaryResetAt && time <= discretionaryResetAt) return false;
        return true;
      });
  }

  function attendanceLabel(value) {
    const labels = { "si": "Sí, voy", "no": "No puedo asistir", "a-confirmar": "Pendiente" };
    return labels[value] || value || "Sin cargar";
  }

  function transportLabel(value) {
    const labels = {
      "particular": "De forma particular",
      "auto": "De forma particular",
      "combi": "Necesito información del micro",
      "micro": "Necesito información del micro",
      "duermo": "Duermo en la estancia"
    };
    return labels[value] || value || "Sin cargar";
  }

  function rsvpThanksTitle(saved) {
    if (saved.attendance === "no") return `Gracias por avisarnos, ${escapeHTML(saved.firstName || currentGuest.firstName)}.`;
    if (saved.attendance === "a-confirmar") return `Respuesta registrada, ${escapeHTML(saved.firstName || currentGuest.firstName)}.`;
    return `Muchas gracias, ${escapeHTML(saved.firstName || currentGuest.firstName)}.`;
  }

  function rsvpThanksText(saved) {
    if (saved.attendance === "no") return "Tu respuesta quedó registrada. Nos va a encantar tenerte cerca igual.";
    if (saved.attendance === "a-confirmar") return "Tu respuesta quedó como pendiente. Podés volver a actualizarla cuando sepas.";
    return "El bosque recibió tu confirmación. Estos son los datos que dejaste registrados:";
  }

  function field(name, label, value = "", type = "text", required = false) {
    return `<label>${escapeHTML(label)}<input name="${name}" type="${type}" value="${escapeHTML(value)}" ${required ? "required" : ""}></label>`;
  }

  function option(value, label, selected) {
    return `<option value="${escapeHTML(value)}" ${value === selected ? "selected" : ""}>${escapeHTML(label)}</option>`;
  }

  function renderProfile() {
    const saved = state.profiles[currentGuest.id] || {};
    const hasSaved = hasCompletedProfile(saved);
    const editing = Boolean(state.profileEditMode || !hasSaved);

    if (hasSaved && !editing) {
      return `
        ${rsvpStyles()}
        ${sectionHeader("ficha secreta", "Ficha secreta registrada", "Tus respuestas ya forman parte del archivo del bosque. Podés editarlas cuando quieras.")}
        <section class="section-card form-card rsvp-thank-card">
          <div class="rsvp-thank-grid">
            <div>
              <div class="rsvp-okmark">✓</div>
              <h4 class="rsvp-thank-title">Muchas gracias, ${escapeHTML(currentGuest.firstName)}.</h4>
              <p class="rsvp-thank-lead">Tu ficha secreta quedó guardada. Esta acción ya suma puntos para el equipo ${escapeHTML(getTeam(currentGuest.team).name)} y no vuelve a sumar aunque la edites.</p>

              <div class="rsvp-summary-grid">
                ${summaryLine("Color preferido", saved.favoriteColor || "Sin cargar")}
                ${summaryLine("Canción que quiero", saved.songYes || "Sin cargar")}
                ${summaryLine("Canción que NO quiero", saved.songNo || "Sin cargar")}
                ${summaryLine("Comida preferida", saved.favoriteFood || "Sin cargar")}
                ${summaryLine("Postre preferido", saved.favoriteDessert || "Sin cargar")}
                ${summaryLine("Competitividad", saved.competitive ? `${saved.competitive}/10` : "Sin cargar")}
                ${summaryLine("Deseo para los novios", saved.wish || "Sin cargar", true)}
                ${summaryLine("Desafío para los novios", saved.challenge || "Sin cargar", true)}
                ${summaryLine("Secreto", saved.secret || "Sin cargar", true)}
                ${summaryLine("Habilidad", saved.skill || "Sin cargar")}
                ${summaryLine("Debilidad", saved.weakness || "Sin cargar")}
              </div>

              <div class="rsvp-actions-row">
                <button id="editProfile" type="button">Editar mi ficha</button>
              </div>

              <p class="form-note">Última edición: ${formatDateLabel(saved.updatedAt)}</p>
            </div>

            <aside class="rsvp-side-note">
              <h4>Tu aporte ya sumó</h4>
              <p>Completar la ficha secreta suma una sola vez para tu equipo. Podés editar tus respuestas más adelante, pero no duplica puntos.</p>
              <p>Estas respuestas pueden usarse en trivias, playlist, bingo, secretos y desafíos durante la previa o la fiesta.</p>
            </aside>
          </div>
        </section>`;
    }

    return `
      ${sectionHeader("ficha secreta", hasSaved ? "Editar ficha secreta" : "Material clasificado para juegos", "Estas respuestas pueden convertirse en trivia, bingo, desafíos, playlist, premios o confesiones anónimas.")}
      <form id="profileForm" class="section-card form-card">
        <div class="warning-ribbon">Tus respuestas podrán ser usadas en tu contra durante la noche. Completar esta ficha suma puntos una sola vez para tu equipo.</div>
        <div class="form-grid">
          ${field("favoriteColor", "Color preferido", saved.favoriteColor || "")}
          ${field("songYes", "Canción que quiero que pasen", saved.songYes || "")}
          ${field("songNo", "Canción que NO quiero que pasen", saved.songNo || "")}
          ${field("favoriteFood", "Comida preferida", saved.favoriteFood || "")}
          ${field("favoriteDessert", "Postre preferido", saved.favoriteDessert || "")}
          <label>Qué tan competitivo soy
            <select name="competitive">
              ${["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map(v => option(v, v ? `${v}/10` : "Seleccionar", saved.competitive)).join("")}
            </select>
          </label>
        </div>
        <label>Mi deseo para los novios<textarea name="wish">${escapeHTML(saved.wish || "")}</textarea></label>
        <label>Mi desafío para los novios<textarea name="challenge">${escapeHTML(saved.challenge || "")}</textarea></label>
        <label>Un secreto<textarea name="secret" placeholder="Puede ser anónimo, vergonzoso o útil para un juego...">${escapeHTML(saved.secret || "")}</textarea></label>
        <div class="form-grid">
          ${field("skill", "Habilidad que aporto a mi equipo", saved.skill || "")}
          ${field("weakness", "Debilidad que oculto", saved.weakness || "")}
        </div>
        <div class="form-actions"><button type="submit">${hasSaved ? "Guardar cambios" : "Guardar ficha secreta"}</button>${hasSaved ? `<button id="cancelProfileEdit" type="button" class="ghost-button">Cancelar edición</button>` : ""}<span class="form-note">${saved.updatedAt ? `Última edición: ${formatDateLabel(saved.updatedAt)}` : "Pendiente de carga."}</span></div>
      </form>`;
  }


  function guestChallengeProgress(guest) {
    if (!isCompetitionGuest(guest)) return { completed: 0, total: 0, label: "Fuera de competencia" };
    const checks = [
      hasCompletedRsvp(state.rsvps[guest.id]),
      Boolean(state.gameSubmissions[`${guest.id}::music-selection`]),
      Boolean(state.gameSubmissions[`${guest.id}::couple-trivia-test`]),
      Boolean(state.gameSubmissions[`${guest.id}::who-is-who-trivia-test`])
    ];
    const completed = checks.filter(Boolean).length;
    return { completed, total: checks.length, label: `${completed} de ${checks.length} desafíos` };
  }

  function renderTeam() {
    const guestsSectionOpen = isSectionOpen("invitados");
    if (!guestsSectionOpen) teamCommunityTab = "mine";

    const selectedTeamId = selectedTeamViewId || currentGuest.team;
    const team = getTeam(selectedTeamId);
    const members = DATA.guests
      .filter(guest => guest.team === team.id && isCompetitionGuest(guest))
      .sort((a, b) => {
        const captainDiff =
          Number(isGuestCaptain(b)) -
          Number(isGuestCaptain(a));

        if (captainDiff) return captainDiff;

        const completedDiff =
          guestChallengeProgress(b).completed -
          guestChallengeProgress(a).completed;

        if (completedDiff) return completedDiff;

        return guestFullName(a).localeCompare(
          guestFullName(b),
          "es",
          { sensitivity: "base" }
        );
      });
    const activePlayers = members.length;
    const confirmed = completedRsvpMembers(team.id).length;
    const percent = Math.min(
      100,
      Math.round((confirmed / Math.max(activePlayers, 1)) * 100)
    );
    const ranking = calculateRanking();
    const rankingIndex = ranking.findIndex(row => row.id === team.id);
    const teamPoints = ranking.find(row => row.id === team.id)?.total || 0;
    const teamPosition = ranking.some(row => Number(row.total || 0) !== 0)
      ? `${rankingIndex + 1}º`
      : "—";

    const tabs = guestsSectionOpen
      ? `
        <section class="team-community-tabs section-card">
          <button
            type="button"
            data-team-community-tab="mine"
            class="${teamCommunityTab === "mine" ? "active" : ""}">
            ${uiIcon("team")}<span>Mi equipo</span>
          </button>
          <button
            type="button"
            data-team-community-tab="all"
            class="${teamCommunityTab === "all" ? "active" : ""}">
            ${uiIcon("guests")}<span>Todos los equipos</span>
          </button>
        </section>`
      : "";

    if (teamCommunityTab === "all" && guestsSectionOpen) {
      return `
        ${captainGuestStyles()}
        ${guestAccordionStyles()}
        ${teamCommunityStyles()}
        ${tabs}
        ${renderAllTeamsAccordion()}`;
    }

    return `
      ${captainGuestStyles()}
      ${teamCommunityStyles()}
      ${tabs}

      <section class="team-summary-compact section-card" style="--local-accent:${team.accent}">
        <div class="team-summary-head">
          ${teamLogo(team, "team-summary-logo")}
          <div class="team-summary-copy">
            <p class="eyebrow">Mi equipo</p>
            <h3>${escapeHTML(team.name)}</h3>
            <small>Capitán: ${escapeHTML(team.captain)}</small>
          </div>
        </div>

        <button type="button" data-go="ranking" class="team-ranking-bluebar">
          <span class="team-ranking-bluebar-title">
            ${uiIcon("ranking")}
            <strong>Ranking</strong>
          </span>
          <span class="team-ranking-bluebar-stat">
            <small>Posición</small>
            <b>${teamPosition}</b>
          </span>
          <span class="team-ranking-bluebar-stat">
            <small>Puntos</small>
            <b>${teamPoints}</b>
          </span>
          <span class="team-ranking-bluebar-stat">
            <small>Integrantes</small>
            <b>${activePlayers}</b>
          </span>
        </button>
      </section>

      <section class="team-attendance-mini section-card">
        <span>${uiIcon("calendar")}</span>
        <div>
          <strong>${confirmed} de ${activePlayers} confirmaron asistencia</strong>
          <i><em style="width:${percent}%"></em></i>
        </div>
        <b>${percent}%</b>
      </section>

      <section class="section-card team-members-card">
        <div class="card-title-row">
          <h4>Integrantes y desafíos</h4>
          <span class="badge">${members.length}</span>
        </div>
        <div class="guest-list team-member-list">
          ${members.map(guest =>
            guestPill(
              guest,
              {
                minimalIcon: true,
                showChallenges: true,
                hideAlias: true
              }
            )
          ).join("")}
        </div>
      </section>`;
  }

  function teamCommunityStyles() {
    return `<style>
      .team-community-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;padding:6px}
      .team-community-tabs button{min-height:39px;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 9px;border:0;border-radius:11px;background:transparent;color:var(--muted);box-shadow:none;font-size:9px;font-weight:900}
      .team-community-tabs button.active{background:#31536e;color:#fff}
      .team-community-tabs .ui-icon{width:16px;height:16px}
    </style>`;
  }


  function captainGuestStyles() {
    return `<style>
      .guest-pill.captain-pill{border-color:rgba(201,170,114,.72);background:linear-gradient(135deg,rgba(201,170,114,.17),rgba(255,255,255,.52));box-shadow:0 0 0 1px rgba(201,170,114,.10) inset}.captain-label{display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:3px 7px;border-radius:999px;background:rgba(201,170,114,.15);color:var(--gold-deep);font-weight:950;font-size:9px;text-transform:uppercase;letter-spacing:.06em}
      .guest-pill.is-declined{filter:grayscale(1);opacity:.52;border-style:solid;background:rgba(220,220,216,.38)!important}.guest-pill.is-declined .guest-person-icon{background:rgba(100,100,100,.08);color:#777}.declined-label{display:inline-flex;margin-top:4px;color:#666;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.06em}
    </style>`;
  }

  function guestPill(guest, options = {}) {
    const captain = isGuestCaptain(guest);
    const declined = hasCompletedRsvp(state.rsvps[guest.id]) && state.rsvps[guest.id]?.attendance === "no";
    const visibleRole = guest.roleVisible || guest.displayRelation || guest.relation || guest.role || "invitado";
    const aliasText = guest.alias ? `${guest.alias} · ${visibleRole}` : visibleRole;
    const progress = guestChallengeProgress(guest);
    const initial = String(guest.firstName || guest.lastName || "?").trim().charAt(0).toUpperCase();
    const icon = `<span class="guest-person-initial ${captain ? "is-captain" : ""}">${escapeHTML(initial)}</span>`;
    const challengeStatus = options.showChallenges ? `<div class="guest-challenge-status"><span><b>${progress.completed}/${progress.total}</b><em>desafíos</em></span><i><em style="width:${Math.round((progress.completed / Math.max(progress.total,1)) * 100)}%"></em></i></div>` : "";
    const secondaryText = options.hideAlias ? "" : `<small>${escapeHTML(aliasText)}</small>`;

    return `<div class="guest-pill ${captain ? "captain-pill" : ""} ${declined ? "is-declined" : ""} ${options.showChallenges ? "has-challenges" : ""} ${options.hideAlias ? "without-alias" : ""}"><span class="guest-pill-avatar">${icon}</span><div class="guest-pill-copy"><strong>${escapeHTML(guestFullName(guest))}</strong>${secondaryText}${captain ? `<span class="captain-label">Capitán</span>` : ""}${declined ? `<span class="declined-label">No asiste</span>` : ""}${challengeStatus}</div></div>`;
  }


  function renderPointsHub() {
    const team = getTeam(currentGuest.team);
    const rsvp = state.rsvps[currentGuest.id];
    const rsvpDone = isCompetitionGuest(currentGuest) && hasFinalRsvp(rsvp);
    const myPoints = calculateRanking().find(row => row.id === team.id)?.total || 0;
    const activityPoints = rsvpPointsForTeam(team.id);
    const musicOpen = isTriviaGameOpen("trivia-music");
    const triviaOpen = isTriviaGameOpen("trivia-couple");
    const whoTriviaOpen = isTriviaGameOpen("trivia-who");
    const travelOpen = isSectionOpen("en-viaje");
    const musicDone = Boolean(triviaSubmission("music-selection"));
    const triviaDone = Boolean(triviaSubmission("couple-trivia-test"));
    const whoTriviaDone = Boolean(triviaSubmission("who-is-who-trivia-test"));
    const currentGamesDone = rsvpDone && musicDone && triviaDone && whoTriviaDone;
    const pointsTitle = currentGamesDone
      ? "¡Ya completaste los desafíos!"
      : "Qué podés hacer ahora";
    const pointsText = currentGamesDone
      ? "Mientras esperás a que lleguen nuevos, deciles a los demás grupos quién va a ganar."
      : "Mientras esperamos las confirmaciones, ya podés preparar tu aporte para el equipo.";

    return `
      ${pointsHubStyles()}
      <section class="points-compact-head section-card ${currentGamesDone ? "is-completed" : ""}" style="--local-accent:${team.accent}">
        ${teamLogo(team,"points-compact-logo")}
        <div>
          <p class="eyebrow">Sumá puntos</p>
          <h3>${escapeHTML(pointsTitle)}</h3>
          <p>${escapeHTML(pointsText)}</p>
        </div>
        <span><b>${myPoints}</b><small>puntos</small></span>
      </section>

      ${currentGamesDone ? `
        <section class="points-social-cta points-social-cta--highlight section-card">
          <span>${uiIcon("chat")}</span>
          <div>
            <h4>Hablales a los otros equipos</h4>
            <p>Deciles quién va a ganar la competencia.</p>
          </div>
          <button type="button" data-go="social">Ir a Social</button>
        </section>
      ` : ""}

      ${isSectionOpen("reglas") ? `
        <button type="button" class="points-rules-entry section-card" data-go="reglas">
          <span>${uiIcon("rules")}</span>
          <div>
            <strong>Cómo funciona la competencia</strong>
            <small>Consultá las reglas y todas las formas de sumar o restar puntos.</small>
          </div>
          <b aria-hidden="true">›</b>
        </button>
      ` : ""}

      <section class="points-compact-list section-card">
        ${pointsAction({
          icon:"✉️",
          title:"Confirmar asistencia",
          text:rsvpDone
            ? `Respuesta guardada. Sumaste ${activityPoints} puntos.`
            : `Respondé por sí o por no y sumá ${activityPoints} puntos.`,
          done:rsvpDone,
          route:"asistencia",
          progressText:`${activityPoints} puntos`,
          editable:true
        })}
        ${rsvpDone ? `
          ${pointsAction({
            icon:"🎵",
            title:"Elegir canciones",
            text:musicOpen
              ? (
                  musicDone
                    ? `Propuesta guardada. Sumaste ${activityPoints} puntos.`
                    : `Elegí dos canciones y sumá ${activityPoints} puntos.`
                )
              : "Se habilitará más adelante.",
            done:musicDone,
            route:"musica",
            progressText:musicOpen ? `${activityPoints} puntos` : "Bloqueado",
            editable:true,
            locked:!musicOpen
          })}
          ${pointsAction({
            icon:"🎯",
            title:"¿Cuánto conocés a los novios?",
            text:triviaOpen
              ? (triviaDone ? "Resultado cerrado." : "Cinco preguntas de opción múltiple.")
              : "Se habilitará más adelante.",
            done:triviaDone,
            route:"trivia-pareja",
            progressText:triviaOpen ? (triviaDone ? "Resultado final" : "Hasta 100 puntos") : "Bloqueado",
            editable:false,
            locked:!triviaOpen
          })}
          ${pointsAction({
            icon:"⚖️",
            title:"¿Quién es quién?",
            text:whoTriviaOpen
              ? (whoTriviaDone ? "Resultado cerrado." : "Elegí entre Vani o Fede.")
              : "Se habilitará más adelante.",
            done:whoTriviaDone,
            route:"trivia-quien",
            progressText:whoTriviaOpen ? (whoTriviaDone ? "Resultado final" : "Hasta 100 puntos") : "Bloqueado",
            editable:false,
            locked:!whoTriviaOpen
          })}
        ` : `
          <div class="points-rsvp-lock">${uiIcon("lock")}<div><strong>Primero, asistencia</strong><p>Al responder por sí o por no se habilitarán las canciones, la trivia y las próximas actividades.</p></div></div>
        `}

        ${travelOpen ? pointsAction({
          icon:"🚌",
          title:"En viaje",
          text:"Consignas, playlist y actividades según tu forma de traslado.",
          done:false,
          route:"en-viaje",
          progressText:"Actividad especial",
          editable:false
        }) : ""}
      </section>

      <div class="points-coming-soon-note ${currentGamesDone ? "is-completed" : ""}">
        <span aria-hidden="true">${currentGamesDone ? "🕒" : "🔒"}</span>
        <strong>
          ${
            currentGamesDone
              ? "¡Próximamente más desafíos!"
              : "Más juegos y actividades se habilitarán más adelante."
          }
        </strong>
      </div>

      `;
  }

  function pointsAction({ icon, title, text, done, route, progressText = "", editable = true, locked = false }) {
    const label = done ? (editable ? "Ver / editar" : "Ver") : "Ver";
    const progress = progressText
      ? `<small>${escapeHTML(progressText)}</small>`
      : "";
    const action = locked
      ? `<span class="points-locked-state">${uiIcon("lock")}<b>Bloqueado</b></span>`
      : `<button type="button" data-go="${escapeHTML(route)}">${label}</button>`;

    return `
      <article class="points-action ${done ? "done" : ""} ${locked ? "is-locked" : ""}">
        <span class="points-action-icon">${icon}</span>
        <div class="points-action-copy">
          <strong>${escapeHTML(title)}</strong>
          <p>${escapeHTML(text)}</p>
          ${progress}
        </div>
        <div class="points-action-end">
          ${done ? `<span class="points-complete-badge">${uiIcon("checkCircle")}<b>Hecho</b></span>` : ""}
          ${action}
        </div>
      </article>`;
  }

  function pointsHubStyles() {
    return `<style>
      .points-compact-head{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:11px;align-items:center;padding:13px 15px}.points-compact-logo{width:46px;height:46px}.points-compact-head h3{margin:2px 0;font-size:22px}.points-compact-head p:not(.eyebrow){margin:0;max-width:620px;font-size:10.5px;line-height:1.3}.points-compact-head>span{text-align:center}.points-compact-head>span b,.points-compact-head>span small{display:block}.points-compact-head>span b{font-size:21px}.points-compact-head>span small{font-size:8px;text-transform:uppercase;color:var(--muted)}
      .points-compact-list{padding:8px}.points-action{display:grid;grid-template-columns:37px minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px;border:1px solid rgba(132,104,68,.13);border-radius:14px;background:rgba(255,255,255,.34);margin:6px 0}.points-action.done{border-color:rgba(74,125,79,.22);background:rgba(74,125,79,.055)}.points-action-icon{font-size:22px;text-align:center}.points-action-copy strong{font-size:14px}.points-action-copy p{margin:1px 0;font-size:10.5px;line-height:1.25}.points-action-copy small{color:var(--gold-deep);font-size:9px;font-weight:900}.points-action-end{display:flex;align-items:center;gap:6px}.points-action-end button{min-height:34px;padding:7px 10px}.points-complete-badge{display:inline-flex;align-items:center;gap:4px;color:#426f47;font-size:9px;font-weight:900}.points-complete-badge .ui-icon{width:15px;height:15px}
      .points-rsvp-lock{display:flex;align-items:flex-start;gap:10px;margin:7px 0;padding:12px;border:1px solid rgba(116,51,68,.24);border-radius:14px;background:rgba(116,51,68,.045)}.points-rsvp-lock>.ui-icon{width:21px;height:21px;color:#743344;flex:0 0 auto}.points-rsvp-lock strong{display:block;margin-bottom:2px}.points-rsvp-lock p{margin:0;font-size:11px;line-height:1.35}
      @media(max-width:570px){.points-compact-head{grid-template-columns:40px minmax(0,1fr) auto;padding:11px}.points-compact-logo{width:38px;height:38px}.points-compact-head h3{font-size:19px}.points-action{grid-template-columns:32px minmax(0,1fr);padding:9px}.points-action-icon{font-size:20px}.points-action-end{grid-column:2;justify-content:space-between}.points-action-end button{min-width:84px}.points-action-copy strong{font-size:13px}}
    </style>`;
  }


  function renderTournament() {
    const open = isUnlocked("tournament");
    const ranking = calculateRanking();
    return `
      ${sectionHeader("torneo previo", "Formato Mundial del bosque", "Los desafíos previos ordenan la tabla y pueden entregar ventajas para el día del casamiento.")}
      ${open ? "" : lockedNotice("tournament")}
      <section class="grid two">
        <article class="section-card"><h4>Tabla actual</h4><div class="ranking-list small">${ranking.map(rankRow).join("")}</div></article>
        <article class="section-card"><h4>Regla de clasificación</h4><p>${escapeHTML(DATA.bracket.rule)}</p><div class="bracket-mini">${DATA.bracket.playIn.map(match => `<div><strong>${match.match}</strong><span>${match.seedA} vs ${match.seedB}</span><small>${match.winnerGoesTo}</small></div>`).join("")}${DATA.bracket.semifinals.map(match => `<div><strong>${match.match}</strong><span>${match.seedA} vs ${match.seedB}</span></div>`).join("")}<div><strong>Final</strong><span>${escapeHTML(DATA.bracket.final)}</span></div></div></article>
      </section>
      <section class="section-card"><h4>Desafíos previos</h4><div class="game-grid">${DATA.games.filter(g => g.phase === "Torneo previo").map(renderGameCard).join("")}</div></section>`;
  }

  function lockedNotice(key) {
    const unlock = DATA.unlocks[key];
    return `<div class="locked-banner"><span>🔒</span><div><strong>${escapeHTML(unlock.title)} bloqueado</strong><p>${escapeHTML(unlock.teaser)} Se libera: ${formatDateLabel(unlock.unlockAt)}.</p></div></div>`;
  }

  function renderGames() {
    return `
      ${sectionHeader("juegos", "Desafíos digitales y batalla física", "Los juegos se pueden habilitar antes o durante la fiesta. Las respuestas quedan registradas y los puntos físicos se cargan desde Admin.")}
      <section class="game-grid">${DATA.games.map(renderGameCard).join("")}</section>
    `;
  }

  function renderGameCard(game) {
    const open = isUnlocked(game.unlockKey);
    const key = `${currentGuest.id}::${game.id}`;
    const saved = state.gameSubmissions[key];
    return `
      <article class="game-card ${open ? "" : "locked-panel"}">
        <div class="game-top"><span class="badge">${escapeHTML(game.phase)}</span><span class="points">${game.maxPoints} pts</span></div>
        <h4>${open ? "🎲" : "🔒"} ${escapeHTML(game.title)}</h4>
        <p>${escapeHTML(open ? game.description : DATA.unlocks[game.unlockKey]?.teaser || "Bloqueado")}</p>
        <small>${escapeHTML(game.type)}</small>
        ${open ? `
          <form class="game-submit" data-game-id="${escapeHTML(game.id)}">
            <input name="answer" placeholder="Respuesta / evidencia / link / comentario" value="${escapeHTML(saved?.answer || "")}">
            <button type="submit">Enviar</button>
          </form>
          ${saved ? `<small class="saved-note">Enviado: ${formatDateLabel(saved.updatedAt)}</small>` : ""}` : `<small>Se libera: ${formatDateLabel(DATA.unlocks[game.unlockKey]?.unlockAt)}</small>`}
      </article>`;
  }


  function renderTriviaHub() {
    const team = getTeam(currentGuest.team);
    const musicOpen = isTriviaGameOpen("trivia-music");
    const coupleOpen = isTriviaGameOpen("trivia-couple");
    const whoOpen = isTriviaGameOpen("trivia-who");
    const musicSaved = triviaSubmission("music-selection");
    const triviaSaved = triviaSubmission("couple-trivia-test");
    const whoSaved = triviaSubmission("who-is-who-trivia-test");
    const allDone = Boolean(
      musicSaved &&
      triviaSaved &&
      whoSaved
    );

    return `
      ${triviaHubStyles()}
      ${sectionHeader(
        "sumá puntos",
        "Juegos de Vani y Fede",
        "Elegí una misión, participá y ayudá a tu equipo."
      )}

      ${allDone ? "" : `
        <section class="trivia-prize-banner">
          ${uiIcon("gift")}
          <div>
            <strong>Habrá premios especiales</strong>
            <p>
              Participar, acertar y jugar en equipo
              puede tener recompensa.
            </p>
          </div>
        </section>
      `}

      <section
        class="trivia-game-list ${
          allDone ? "all-completed" : ""
        }">
        ${renderMusicGame(musicOpen, musicSaved, team)}
        ${renderCoupleTrivia(coupleOpen, triviaSaved)}
        ${renderWhoIsWhoTrivia(whoOpen, whoSaved)}
      </section>

      ${allDone ? `
        <section
          id="trivia-upcoming-note"
          class="trivia-upcoming-note">
          <span aria-hidden="true">🕒</span>
          <strong>¡Próximamente más desafíos!</strong>
        </section>
      ` : ""}
    `;
  }


  function renderMusicGame(open, saved, team) {
    if (!open) {
      return renderLockedTriviaCard(
        "01",
        "La banda sonora",
        "Dos canciones tendrán una misión especial.",
        "trivia-music",
        "music-game"
      );
    }

    if (saved && !musicEditMode) {
      return `
        <article
          id="music-game"
          class="trivia-game-card is-open is-completed is-compact-completed music-game-summary">
          <div class="trivia-game-number">01</div>
          <div class="trivia-game-content">
            <div class="trivia-game-heading">
              <div>
                <span class="trivia-status completed">
                  Completado
                </span>
                <h4>La banda sonora</h4>
              </div>
              ${uiIcon("checkCircle","trivia-main-icon")}
            </div>

            <div class="music-compact-values">
              <span>
                <small>Boda</small>
                <strong>
                  ${escapeHTML(saved.weddingSong || "Canción guardada")}
                </strong>
              </span>
              <span>
                <small>Equipo</small>
                <strong>
                  ${escapeHTML(saved.teamEntranceSong || "Canción guardada")}
                </strong>
              </span>
            </div>

            <button
              id="editMusicGame"
              type="button"
              class="trivia-compact-edit">
              Editar
            </button>
          </div>
        </article>`;
    }

    return `
      <article
        id="music-game"
        class="trivia-game-card is-open music-game-compact">
        <div class="trivia-game-number">01</div>
        <div class="trivia-game-content">
          <div class="trivia-game-heading">
            <div>
              <span class="trivia-status open">
                ${saved ? "Editando" : "Disponible"}
              </span>
              <h4>La banda sonora</h4>
            </div>
            ${uiIcon("music","trivia-main-icon")}
          </div>

          <p>
            Elegí una canción para la boda y otra para
            la entrada del equipo ${escapeHTML(team.name)}.
          </p>

          <form id="musicGameForm" class="trivia-form">
            <label>
              Canción para la boda
              <input
                name="weddingSong"
                type="text"
                value="${escapeHTML(saved?.weddingSong || "")}"
                placeholder="Tema y artista"
                required>
            </label>

            <label>
              Canción para la entrada del equipo
              <input
                name="teamEntranceSong"
                type="text"
                value="${escapeHTML(saved?.teamEntranceSong || "")}"
                placeholder="Tema y artista"
                required>
            </label>

            <label>
              Motivo <span>(opcional)</span>
              <textarea
                name="reason"
                placeholder="¿Por qué la elegiste?">${escapeHTML(saved?.reason || "")}</textarea>
            </label>

            <div class="trivia-form-footer">
              <button type="submit">
                ${saved ? "Guardar cambios" : "Enviar canciones"}
              </button>
            </div>
          </form>
        </div>
      </article>`;
  }


  function renderCoupleTrivia(open, saved) {
    if (!open) {
      return renderLockedTriviaCard(
        "02",
        "¿Cuánto conocés a los novios?",
        "Cinco preguntas sobre la historia de Vani y Fede.",
        "trivia-couple",
        "couple-trivia-game"
      );
    }

    if (saved) {
      const earnedPoints = Math.max(
        0,
        Number(saved.earnedPoints ?? (Number(saved.score ?? saved.bestScore ?? 0) * 20))
      );

      return `
        <article id="couple-trivia-game" class="trivia-game-card is-open trivia-quiz-card is-completed is-compact-completed">
          <div class="trivia-game-number">02</div>
          <div class="trivia-game-content">
            <div class="trivia-game-heading">
              <div>
                <span class="trivia-status completed">Completada</span>
                <h4>¿Cuánto conocés a los novios?</h4>
              </div>
              ${uiIcon("checkCircle","trivia-main-icon")}
            </div>
            <div
              id="couple-trivia-result"
              class="trivia-result trivia-result-final">
              ${uiIcon("star")}
              <div>
                <strong>${earnedPoints} puntos</strong>
                <span>Resultado final obtenido para tu equipo</span>
              </div>
            </div>
          </div>
        </article>`;
    }

    return `
      <article id="couple-trivia-game" class="trivia-game-card is-open trivia-quiz-card">
        <div class="trivia-game-number">02</div>
        <div class="trivia-game-content">
          <div class="trivia-game-heading">
            <div>
              <span class="trivia-status open">Una sola oportunidad</span>
              <h4>¿Cuánto conocés a los novios?</h4>
            </div>
            ${uiIcon("question","trivia-main-icon")}
          </div>

          <p>Respondé cinco preguntas. Cada acierto suma <strong>20 puntos</strong>: podés conseguir hasta <strong>100 puntos</strong> para tu equipo.</p>

          <div class="trivia-points-rule">
            ${uiIcon("star")}
            <span>Cuando envíes las respuestas, el resultado quedará cerrado.</span>
          </div>

          <form id="coupleTriviaForm" class="trivia-quiz-form">
            ${SAMPLE_COUPLE_QUESTIONS.map((item,index) => `
              <fieldset class="trivia-question">
                <legend>
                  <span>${String(index + 1).padStart(2,"0")}</span>
                  ${escapeHTML(item.question)}
                </legend>
                <div class="trivia-options">
                  ${item.options.map(option => `
                    <label>
                      <input type="radio" name="${item.id}" value="${escapeHTML(option)}" required>
                      <span>${escapeHTML(option)}</span>
                    </label>
                  `).join("")}
                </div>
              </fieldset>
            `).join("")}
            <button type="submit">Enviar respuestas</button>
          </form>
        </div>
      </article>`;
  }


  function renderWhoIsWhoTrivia(open, saved) {
    if (!open) {
      return renderLockedTriviaCard(
        "03",
        "¿Quién es quién? · Vani o Fede",
        "Cinco situaciones para descubrir quién es quién.",
        "trivia-who",
        "who-is-who-game"
      );
    }

    if (saved) {
      const earnedPoints = Math.max(
        0,
        Number(saved.earnedPoints ?? (Number(saved.score ?? saved.bestScore ?? 0) * 20))
      );

      return `
        <article id="who-is-who-game" class="trivia-game-card is-open trivia-quiz-card trivia-who-card is-completed is-compact-completed">
          <div class="trivia-game-number">03</div>
          <div class="trivia-game-content">
            <div class="trivia-game-heading">
              <div>
                <span class="trivia-status completed">Completada</span>
                <h4>¿Quién es quién? · Vani o Fede</h4>
              </div>
              ${uiIcon("checkCircle","trivia-main-icon")}
            </div>
            <div
              id="who-is-who-result"
              class="trivia-result trivia-result-final">
              ${uiIcon("star")}
              <div>
                <strong>${earnedPoints} puntos</strong>
                <span>Resultado final obtenido para tu equipo</span>
              </div>
            </div>
          </div>
        </article>`;
    }

    return `
      <article id="who-is-who-game" class="trivia-game-card is-open trivia-quiz-card trivia-who-card">
        <div class="trivia-game-number">03</div>
        <div class="trivia-game-content">
          <div class="trivia-game-heading">
            <div>
              <span class="trivia-status open">Una sola oportunidad</span>
              <h4>¿Quién es quién? · Vani o Fede</h4>
            </div>
            ${uiIcon("question","trivia-main-icon")}
          </div>

          <p>Elegí entre <strong>Vani</strong> o <strong>Fede</strong>. Cada acierto suma <strong>20 puntos</strong>: podés conseguir hasta <strong>100 puntos</strong>.</p>

          <div class="trivia-points-rule">
            ${uiIcon("star")}
            <span>Cuando envíes las respuestas, el resultado quedará cerrado.</span>
          </div>

          <form id="whoIsWhoTriviaForm" class="trivia-quiz-form">
            ${WHO_IS_WHO_QUESTIONS.map((item,index) => `
              <fieldset class="trivia-question trivia-who-question">
                <legend>
                  <span>${String(index + 1).padStart(2,"0")}</span>
                  ${escapeHTML(item.question)}
                </legend>
                <div class="trivia-options trivia-binary-options">
                  ${item.options.map(option => `
                    <label>
                      <input type="radio" name="${item.id}" value="${escapeHTML(option)}" required>
                      <span>${escapeHTML(option)}</span>
                    </label>
                  `).join("")}
                </div>
              </fieldset>
            `).join("")}
            <button type="submit">Enviar respuestas</button>
          </form>
        </div>
      </article>`;
  }


  function renderLockedTriviaCard(number, title, text, key, elementId = "") {
    return `<article ${elementId?`id="${elementId}"`:""} class="trivia-game-card is-locked"><div class="trivia-game-number">${number}</div><div class="trivia-game-content"><div class="trivia-game-heading"><div><span class="trivia-status locked">Bloqueado</span><h4>${escapeHTML(title)}</h4></div>${uiIcon("lock","trivia-main-icon")}</div><p>${escapeHTML(text)}</p><small>Se habilitará cuando Vani y Fede liberen este juego.</small></div></article>`;
  }

  function triviaHubStyles() {
    return `<style>
      .trivia-prize-banner{display:flex;align-items:center;gap:13px;padding:16px 19px;border:1px solid rgba(154,110,47,.23);border-radius:19px;background:linear-gradient(135deg,rgba(201,170,114,.16),rgba(255,253,248,.84));color:#8a6129}.trivia-prize-banner>.ui-icon{width:27px;height:27px}.trivia-prize-banner strong{display:block;color:var(--ink);font-size:16px}.trivia-prize-banner p{margin:2px 0 0;font-size:13px}
      .trivia-game-list{display:grid;gap:15px}.trivia-game-card{position:relative;display:grid;grid-template-columns:66px minmax(0,1fr);gap:18px;padding:23px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(180deg,rgba(255,253,248,.90),rgba(239,228,209,.76));box-shadow:0 10px 25px rgba(76,51,22,.06);overflow:hidden}.trivia-game-card.is-locked{opacity:.76}.trivia-game-card.is-locked::after{content:"";position:absolute;inset:0;background:linear-gradient(120deg,transparent,rgba(255,255,255,.18));pointer-events:none}
      .trivia-game-number{width:54px;height:54px;display:grid;place-items:center;border:1px solid rgba(201,170,114,.28);border-radius:16px;background:rgba(201,170,114,.12);color:var(--gold-deep);font-family:var(--font-title);font-size:20px;font-weight:900}.trivia-game-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.trivia-game-heading h4{margin:6px 0 8px;font-size:clamp(23px,3vw,31px)}.trivia-main-icon{width:31px;height:31px;color:#743344}.trivia-status{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.trivia-status.open,.trivia-status.completed{background:rgba(74,125,79,.10);color:#426f47}.trivia-status.locked{background:rgba(132,104,68,.10);color:var(--muted)}
      .trivia-game-content>p{margin:0 0 14px}.trivia-points-rule{display:flex;align-items:flex-start;gap:9px;margin:10px 0 14px;padding:11px 13px;border:1px solid rgba(154,110,47,.18);border-radius:13px;background:rgba(201,170,114,.09);color:#765529;font-size:12px;font-weight:750;line-height:1.4}.trivia-points-rule .ui-icon{width:18px;height:18px;flex:0 0 auto}.trivia-secret-note{margin:12px 0 16px;padding:12px 14px;border-left:3px solid #743344;border-radius:0 12px 12px 0;background:rgba(116,51,68,.055);color:var(--muted);font-size:13px;font-weight:700;line-height:1.45}
      .trivia-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.trivia-form label:last-of-type,.trivia-form-footer{grid-column:1/-1}.trivia-form label>span{color:var(--muted-2);font-weight:600}.trivia-form textarea{min-height:85px}.trivia-form-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.trivia-saved{display:inline-flex;align-items:center;gap:7px;color:#426f47;font-weight:850;font-size:13px}.trivia-saved .ui-icon{width:18px;height:18px}
      .trivia-result{display:flex;align-items:center;gap:11px;margin:12px 0 18px;padding:13px 15px;border:1px solid rgba(74,125,79,.20);border-radius:15px;background:rgba(74,125,79,.08);color:#426f47}.trivia-result>.ui-icon{width:24px;height:24px}.trivia-result strong,.trivia-result span{display:block}.trivia-result strong{font-size:18px}.trivia-result span{font-size:12px}
      .trivia-quiz-form{display:grid;gap:16px}.trivia-question{margin:0;padding:16px;border:1px solid rgba(132,104,68,.16);border-radius:17px;background:rgba(255,255,255,.35)}.trivia-question legend{display:flex;align-items:center;gap:10px;padding:0 7px;color:var(--ink);font-weight:900}.trivia-question legend>span{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:rgba(201,170,114,.15);color:var(--gold-deep);font-size:11px}.trivia-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.trivia-options label{position:relative;margin:0}.trivia-options input{position:absolute;opacity:0;pointer-events:none}.trivia-options label>span{display:flex;align-items:center;min-height:46px;padding:10px 13px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.45);color:var(--ink);font-size:13px;font-weight:750;cursor:pointer}.trivia-options label:has(input:checked)>span{border-color:#743344;background:rgba(116,51,68,.09);color:#652c3b;box-shadow:0 0 0 2px rgba(116,51,68,.08)}
      .trivia-game-card{scroll-margin-top:120px}.trivia-quiz-card.is-completed{border-color:rgba(74,125,79,.25);background:linear-gradient(135deg,rgba(74,125,79,.08),rgba(255,253,248,.92))}.trivia-result-final strong{font-size:28px}
      @media(max-width:650px){.trivia-game-card{grid-template-columns:48px minmax(0,1fr);gap:12px;padding:17px}.trivia-game-number{width:44px;height:44px;font-size:16px}.trivia-main-icon{width:26px;height:26px}.trivia-form{grid-template-columns:1fr}.trivia-form label:last-of-type,.trivia-form-footer{grid-column:auto}.trivia-form-footer{align-items:stretch;flex-direction:column}.trivia-form-footer button{width:100%}.trivia-options{grid-template-columns:1fr}}
    </style>`;
  }

  function renderRankingSocialHighlights() {
    const highlights = socialEngagementPosts(3);

    return `
      <section class="ranking-social-unified section-card">
        <div class="ranking-social-unified-head">
          <span>${uiIcon("chat")}</span>
          <div>
            <p class="eyebrow">Social</p>
            <h4>Mensajes destacados</h4>
            <small>Lo más comentado y votado entre los equipos.</small>
          </div>
          <button type="button" data-go="social">Ir a Social</button>
        </div>

        ${highlights.length
          ? `<div class="ranking-social-highlight-list">
              ${highlights.map((item, index) => {
                const author = socialAuthor(item.post);
                return `
                  <button type="button" class="ranking-social-highlight" data-go="social">
                    <span class="ranking-social-highlight-position">${index + 1}</span>
                    <span class="ranking-social-highlight-avatar">${escapeHTML(author.initial)}</span>
                    <span class="ranking-social-highlight-copy">
                      <strong>${escapeHTML(author.name)} · ${escapeHTML(author.team.name)}</strong>
                      <small>${escapeHTML(socialMessageExcerpt(item.post.message))}</small>
                    </span>
                    <span class="ranking-social-highlight-stats">
                      <b>${uiIcon("heart")}${item.likes}</b>
                      <b>${uiIcon("chat")}${item.replies}</b>
                    </span>
                  </button>`;
              }).join("")}
            </div>`
          : `<p class="ranking-social-empty">Todavía no hay mensajes con likes o respuestas.</p>`}
      </section>`;
  }


  function renderRanking() {
    const ranking = calculateRanking();

    return `
      <section class="vf18-ranking-card section-card">
        <div class="vf18-ranking-head">
          <div class="vf18-ranking-title">
            <p class="eyebrow">Competencia</p>
            <h3>Ranking de equipos</h3>
            <p class="vf20-ranking-description">Los equipos competirán durante toda la fiesta para quedarse con el primer puesto.</p>
          </div>
        </div>

        <div class="vf18-ranking-list" aria-label="Tabla de posiciones">
          ${ranking.map(vf18RankRow).join("")}
        </div>

        <div class="vf18-ranking-actions vf18-ranking-actions-bottom">
          <button id="refreshRanking" type="button" class="vf18-ranking-action vf18-ranking-refresh">
            <span class="ranking-button-icon">${uiIcon("sync")}</span>
            <span>Actualizar</span>
          </button>
          <button type="button" data-go="puntos" class="vf18-ranking-action vf18-ranking-points">
            <span class="ranking-button-icon">${uiIcon("star")}</span>
            <span>Sumá puntos</span>
          </button>
        </div>
      </section>

      ${renderRankingSocialHighlights()}`;
  }

  function vf18RankRow(row, index) {
    const team = getTeam(row.id);
    const ownTeam = currentGuest?.team === team.id;

    return `
      <article
        class="vf18-rank-row ${ownTeam ? "is-my-team" : ""} ${index === 0 ? "is-first" : ""}"
        style="--vf18-team-accent:${team.accent}"
        aria-label="${index + 1}. ${escapeHTML(team.name)}, ${row.total} puntos">
        <span class="vf18-rank-position">${index + 1}</span>
        <span class="vf18-rank-logo">${teamLogo(team, "vf18-rank-team-logo")}</span>
        <span class="vf18-rank-name">
          <strong>${escapeHTML(team.name)}</strong>
          ${ownTeam ? `<small>Tu equipo</small>` : ""}
        </span>
        <span class="vf18-rank-score">
          <b>${row.total}</b>
          <small>pts</small>
        </span>
      </article>`;
  }


  function calculateRanking() {
    if (
      Array.isArray(state.serverRanking) &&
      state.serverRanking.length
    ) {
      return state.serverRanking
        .filter(row => DATA.teams[row.id])
        .map(row => ({
          id: row.id,
          total: Number(row.total || 0)
        }))
        .sort(
          (a, b) =>
            b.total - a.total ||
            DATA.teams[a.id].name.localeCompare(
              DATA.teams[b.id].name
            )
        );
    }

    const totals = Object.keys(DATA.teams).map(id => ({
      id,
      total: 0
    }));

    for (const entry of allPointEntries()) {
      const row = totals.find(item => item.id === entry.teamId);
      if (row) row.total += Number(entry.points || 0);
    }

    return totals.sort(
      (a, b) =>
        b.total - a.total ||
        DATA.teams[a.id].name.localeCompare(DATA.teams[b.id].name)
    );
  }

  function gameName(id) {
    if (id === "auto-rsvp") return "Confirmación de asistencia";
    if (id === "auto-music-selection") return "Juego musical";
    if (id === "auto-micro-transport") return "Bonus por viajar en micro";
    if (id === "auto-couple-trivia") return "¿Cuánto conocés a los novios?";
    if (id === "auto-who-is-who-trivia") return "¿Quién es quién?";
    if (id === "discrecional-fede-vani") return "Puntos a discreción";
    if (["reset-discretionary-clear-marker", "reset-discrecional-fede-vani"].includes(id)) return "Limpieza de puntos discrecionales";
    if (["reset-total-clear-marker", "reset-total-fede-vani"].includes(id)) return "Limpieza general de puntos";
    return DATA.games.find(game => game.id === id)?.title || id || "Juego";
  }

  function renderGuests() {
    teamCommunityTab = "all";
    return renderTeam();
  }

  function renderAllTeamsAccordion() {
    if (expandedGuestTeamId === null) {
      expandedGuestTeamId = currentGuest?.team || "";
    }

    const grouped = Object.values(DATA.teams).map(team => ({
      team,
      guests: DATA.guests
        .filter(guest =>
          guest.team === team.id &&
          isCompetitionGuest(guest)
        )
        .sort(sortGuestsForDisplay)
    }));

    return `
      <div class="section-head team-all-head">
        <p class="eyebrow">Comunidad</p>
        <h3>Todos los equipos</h3>
        <p>Tocá un equipo para desplegar sus integrantes.</p>
      </div>

      <section class="guest-team-accordion">
        ${grouped.map(group => {
          const expanded = expandedGuestTeamId === group.team.id;

          return `
            <article
              class="guest-team-accordion-card section-card"
              style="--local-accent:${group.team.accent}">
              <button
                type="button"
                class="guest-team-toggle"
                data-guest-team-toggle="${escapeHTML(group.team.id)}"
                aria-expanded="${expanded ? "true" : "false"}">
                ${teamLogo(group.team, "guest-team-toggle-logo")}
                <span>
                  <strong>${escapeHTML(group.team.name)}</strong>
                  <small>${group.guests.length} integrantes</small>
                </span>
                <b>${expanded ? "−" : "+"}</b>
              </button>

              <div class="guest-team-panel ${expanded ? "" : "hidden"}">
                <p>${escapeHTML(group.team.group)}</p>
                <div class="guest-list">
                  ${group.guests.map(guest =>
                    guestPill(
                      guest,
                      {
                        minimalIcon: true,
                        hideAlias: true
                      }
                    )
                  ).join("")}
                </div>
              </div>
            </article>`;
        }).join("")}
      </section>`;
  }

  function guestAccordionStyles() {
    return `<style>
      .guest-team-accordion{display:grid;gap:7px}
      .guest-team-accordion-card{padding:6px 8px;border-color:color-mix(in srgb,var(--local-accent) 18%,var(--line))}
      .guest-team-toggle{width:100%;display:grid;grid-template-columns:42px minmax(0,1fr) 28px;gap:9px;align-items:center;min-height:54px;padding:5px;border:0;background:transparent;color:var(--ink);text-align:left;box-shadow:none}
      .guest-team-toggle-logo{width:40px;height:40px}
      .guest-team-toggle span strong,.guest-team-toggle span small{display:block}
      .guest-team-toggle span strong{font-size:15px}
      .guest-team-toggle span small{margin-top:2px;color:var(--muted);font-size:9px}
      .guest-team-toggle>b{width:26px;height:26px;display:grid;place-items:center;border-radius:9px;background:color-mix(in srgb,var(--local-accent) 9%,#fff);color:var(--local-accent);font-size:17px}
      .guest-team-panel{padding:2px 4px 6px}
      .guest-team-panel>p{margin:0 0 6px 48px;color:var(--muted);font-size:8px}
      .guest-team-panel .guest-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      @media(max-width:620px){.guest-team-panel .guest-list{grid-template-columns:1fr}.guest-team-toggle{grid-template-columns:38px minmax(0,1fr) 26px}.guest-team-toggle-logo{width:36px;height:36px}}
    </style>`;
  }


  function socialAuthor(message) {
    const guest = getGuestById(message.guestId);
    return {
      guest,
      name: guest ? guestFullName(guest) : (message.guestName || "Invitado"),
      team: getTeam(message.teamId || guest?.team),
      initial: String(guest?.firstName || message.guestName || "I").trim().charAt(0).toUpperCase()
    };
  }

  const SOCIAL_EMOJIS = ["😀", "😍", "🥳", "😂", "❤️", "🔥", "👏", "🎉", "🍾", "💍", "✨", "🌙"];

  function socialEmojiToolbar() {
    return `
      <div class="social-media-tools">
        <div class="social-emoji-strip" aria-label="Emoticonos">
          ${SOCIAL_EMOJIS.map(emoji => `
            <button type="button" data-social-emoji="${escapeHTML(emoji)}" aria-label="Agregar ${escapeHTML(emoji)}">${escapeHTML(emoji)}</button>
          `).join("")}
        </div>
      </div>`;
  }

  function formatSocialMessage(value) {
    const safe = escapeHTML(String(value || ""));
    return safe.replace(
      /(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu,
      '<span class="social-sent-emoji">$1</span>'
    );
  }

  function socialReplyMarkup(reply) {
    const author = socialAuthor(reply);
    return `
      <article class="social-reply" style="--social-accent:${author.team.accent}">
        <span class="social-avatar social-avatar-small">${escapeHTML(author.initial)}</span>
        <div class="social-reply-body">
          <div class="social-reply-meta">
            <strong>${escapeHTML(author.name)}</strong>
            <span>${teamLogo(author.team, "social-team-logo")} ${escapeHTML(author.team.name)}</span>
            <time>${escapeHTML(formatSocialDate(reply.timestamp || reply.updatedAt || reply.submittedAt))}</time>
          </div>
          <p>${formatSocialMessage(reply.message || "")}</p>
        </div>
      </article>`;
  }

  function socialPostMarkup(post, replies) {
    const author = socialAuthor(post);
    const likeCount = socialLikeCount(post.messageId);
    const liked = currentGuestLikesMessage(post.messageId);

    return `
      <article class="social-post section-card" style="--social-accent:${author.team.accent}">
        <header class="social-post-header">
          <div class="social-author">
            <span class="social-avatar">${escapeHTML(author.initial)}</span>
            <div>
              <strong>${escapeHTML(author.name)}</strong>
              <span class="social-team-chip">${teamLogo(author.team, "social-team-logo")} Equipo ${escapeHTML(author.team.name)}</span>
            </div>
          </div>
          <time>${escapeHTML(formatSocialDate(post.timestamp || post.updatedAt || post.submittedAt))}</time>
        </header>

        <p class="social-post-text">${formatSocialMessage(post.message || "")}</p>

        <footer class="social-post-footer">
          <div class="social-post-actions">
            <button
              type="button"
              class="social-like-button ${liked ? "is-liked" : ""}"
              data-social-like="${escapeHTML(post.messageId)}"
              aria-pressed="${liked ? "true" : "false"}">
              ${uiIcon("heart")}
              <span>${liked ? "Te gusta" : "Me gusta"}</span>
              <b>${likeCount}</b>
            </button>

            <button type="button" class="social-reply-toggle" data-social-reply="${escapeHTML(post.messageId)}">
              ${uiIcon("chat")}
              <span>Responder</span>
            </button>
          </div>

          <small>${replies.length ? `${replies.length} ${replies.length === 1 ? "respuesta" : "respuestas"}` : "Sé el primero en responder"}</small>
        </footer>

        <form class="social-reply-form hidden" data-social-parent="${escapeHTML(post.messageId)}">
          <textarea name="message" maxlength="400" placeholder="Escribí una respuesta..." required></textarea>
          ${socialEmojiToolbar()}
          <div class="social-reply-actions">
            <button type="button" class="ghost-button" data-social-cancel>Cancelar</button>
            <button type="submit">Responder</button>
          </div>
        </form>

        ${replies.length ? `<div class="social-replies">${replies.map(socialReplyMarkup).join("")}</div>` : ""}
      </article>`;
  }


  function renderSocial() {
    const messages = dedupeSocialMessages(state.socialMessages || []);
    const rootMessages = messages
      .filter(message => !message.parentId)
      .sort((a, b) => socialMessageTime(b) - socialMessageTime(a));

    const repliesByParent = messages.reduce((groups, message) => {
      if (!message.parentId) return groups;
      if (!groups[message.parentId]) groups[message.parentId] = [];
      groups[message.parentId].push(message);
      return groups;
    }, {});

    Object.values(repliesByParent).forEach(replies => {
      replies.sort((a, b) => socialMessageTime(a) - socialMessageTime(b));
    });

    const team = getTeam(currentGuest.team);
    const initial = String(currentGuest.firstName || currentGuest.lastName || "I").charAt(0).toUpperCase();

    return `
      ${socialStyles()}
      <section class="social-title-row">
        ${sectionHeader("comunidad", "Social", "Mensajes para todos los invitados.")}
        <button id="refreshSocial" type="button" class="social-refresh-button">${uiIcon("sync")}<span>Actualizar</span></button>
      </section>

      <form id="socialPostForm" class="social-composer section-card" style="--social-accent:${team.accent}">
        <span class="social-avatar">${escapeHTML(initial)}</span>
        <div>
          <div class="social-composer-meta">
            <strong>${escapeHTML(guestFullName(currentGuest))}</strong>
            <span>${teamLogo(team, "social-team-logo")} Equipo ${escapeHTML(team.name)}</span>
          </div>

          <textarea name="message" maxlength="400" placeholder="Escribí un mensaje para todos..."></textarea>
          ${socialEmojiToolbar()}

          <div class="social-composer-actions">
            <small>Podés usar texto y emoticonos.</small>
            <button type="submit">${uiIcon("chat")}<span>Publicar</span></button>
          </div>
        </div>
      </form>

      <section class="social-feed">
        ${rootMessages.length
          ? rootMessages.map(post => socialPostMarkup(post, repliesByParent[post.messageId] || [])).join("")
          : `<div class="social-empty section-card">${uiIcon("chat")}<strong>Todavía no hay mensajes</strong><p>Podés ser la primera persona en saludar a todos.</p></div>`}
      </section>`;
  }


  function socialStyles() {
    return `<style>
      .social-title-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}.social-title-row>.section-head{flex:1}.social-refresh-button{display:inline-flex;align-items:center;gap:6px;min-height:33px;padding:7px 9px;border:1px solid rgba(54,85,111,.20);border-radius:10px;background:rgba(54,85,111,.06);color:#36556f;box-shadow:none;font-size:9px}.social-refresh-button .ui-icon{width:14px;height:14px}
      .social-composer{display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;padding:13px;border-color:color-mix(in srgb,var(--social-accent) 30%,var(--line))}.social-avatar{width:38px;height:38px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--social-accent) 35%,transparent);border-radius:50%;background:color-mix(in srgb,var(--social-accent) 10%,#fff);color:var(--ink);font-family:var(--font-title);font-size:17px;font-weight:900}.social-avatar-small{width:30px;height:30px;font-size:13px}.social-composer-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.social-composer-meta>strong{font-size:12px}.social-composer-meta>span,.social-team-chip{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:8px;font-weight:850}.social-team-logo{width:16px!important;height:16px!important}.social-composer textarea{width:100%;min-height:68px;margin-top:7px;padding:9px 10px;border-radius:12px;resize:vertical}
      .social-media-tools{display:flex;align-items:center;gap:7px;margin-top:7px}.social-emoji-strip{display:flex;gap:4px;min-width:0;overflow-x:auto;padding:2px 1px;scrollbar-width:none}.social-emoji-strip::-webkit-scrollbar{display:none}.social-emoji-strip button,.social-gif-toggle{min-width:29px;height:29px;display:grid;place-items:center;padding:0;border:1px solid rgba(132,104,68,.14);border-radius:9px;background:rgba(255,255,255,.48);color:var(--ink);box-shadow:none;font-size:15px}.social-gif-toggle{min-width:39px;padding:0 7px;color:#36556f;font-size:9px;font-weight:950}
      .social-gif-field{display:grid;gap:4px;margin-top:7px;padding:8px;border:1px solid rgba(54,85,111,.18);border-radius:11px;background:rgba(54,85,111,.035)}.social-gif-field>span{font-size:9px;font-weight:900}.social-gif-field input{min-height:36px;padding:7px 9px;border-radius:9px;font-size:10px}.social-gif-field small{color:var(--muted);font-size:8px}
      .social-composer-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:7px}.social-composer-actions small{color:var(--muted);font-size:8px}.social-composer-actions button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:7px 11px}.social-composer-actions .ui-icon{width:14px;height:14px}
      .social-feed{display:grid;gap:8px;margin-top:9px}.social-post{padding:12px;border-left:3px solid var(--social-accent)}.social-post-header{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}.social-author{display:grid;grid-template-columns:38px minmax(0,1fr);gap:8px;align-items:center}.social-author strong{display:block;font-size:12px}.social-post-header>time{color:var(--muted);font-size:7px;white-space:nowrap}.social-post-text{margin:10px 0 8px;color:var(--ink);font-size:12px;line-height:1.42;white-space:pre-wrap;word-break:break-word}
      .social-gif{margin:9px 0;overflow:hidden;border:1px solid rgba(132,104,68,.12);border-radius:13px;background:rgba(0,0,0,.03)}.social-gif img{display:block;width:100%;max-height:310px;object-fit:contain}.social-gif-reply{max-width:330px;margin:6px 0 0}.social-gif-reply img{max-height:210px}
      .social-post-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:7px;border-top:1px solid rgba(132,104,68,.10)}.social-post-footer small{color:var(--muted);font-size:8px}.social-reply-toggle{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:5px 8px;border:0;background:transparent;color:#36556f;box-shadow:none;font-size:9px}.social-reply-toggle .ui-icon{width:13px;height:13px}
      .social-reply-form{margin-top:8px;padding:8px;border:1px solid rgba(54,85,111,.13);border-radius:11px;background:rgba(54,85,111,.035)}.social-reply-form textarea{width:100%;min-height:56px;padding:8px 9px;border-radius:9px;resize:vertical}.social-reply-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}.social-reply-form button{min-height:30px;padding:6px 9px;font-size:9px}
      .social-replies{display:grid;gap:6px;margin:9px 0 0 19px;padding-left:9px;border-left:1px solid color-mix(in srgb,var(--social-accent) 30%,var(--line))}.social-reply{display:grid;grid-template-columns:30px minmax(0,1fr);gap:7px;align-items:start;padding:7px;border-radius:10px;background:rgba(255,255,255,.38)}.social-reply-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.social-reply-meta strong{font-size:10px}.social-reply-meta span{display:inline-flex;align-items:center;gap:3px;color:var(--muted);font-size:7px}.social-reply-meta time{margin-left:auto;color:var(--muted);font-size:7px}.social-reply-body p{margin:4px 0 0;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word}.social-empty{display:grid;place-items:center;min-height:160px;text-align:center}.social-empty>.ui-icon{width:29px;height:29px;color:#36556f}.social-empty strong{margin-top:7px}.social-empty p{margin:4px 0 0;font-size:10px}
      @media(max-width:600px){.social-title-row{align-items:center}.social-title-row .section-head p:not(.eyebrow){display:none}.social-refresh-button span{display:none}.social-refresh-button{width:33px;padding:6px}.social-composer{grid-template-columns:34px minmax(0,1fr);padding:10px}.social-avatar{width:34px;height:34px;font-size:15px}.social-author{grid-template-columns:34px minmax(0,1fr)}.social-post{padding:10px}.social-post-text{font-size:11px}.social-replies{margin-left:10px;padding-left:7px}}
    </style>`;
  }


  function renderLocation() {
    const mapsUrl = "https://share.google/JBRF4p4QiJy3muAa7";

    return `
      ${locationStyles()}
      ${sectionHeader("casamiento", "Ubicación", "La locación y el acceso para llegar sin vueltas.")}

      <section class="location-hero section-card">
        <span>${uiIcon("pin")}</span>
        <div>
          <p class="eyebrow">Lugar</p>
          <h3>Estancia Los Candiles</h3>
          <p>Solís, Provincia de Buenos Aires.</p>
          <a href="${mapsUrl}" target="_blank" rel="noopener">
            ${uiIcon("pin")}<span>Abrir en Google Maps</span>
          </a>
        </div>
      </section>

      <section class="location-note section-card">
        ${uiIcon("car")}
        <div>
          <strong>Viajando de forma particular</strong>
          <p>Usá el acceso a Maps para abrir la ruta desde tu ubicación. El día del evento también compartiremos cualquier indicación adicional necesaria.</p>
        </div>
      </section>`;
  }

  function locationStyles() {
    return `<style>
      .location-hero{display:grid;grid-template-columns:60px minmax(0,1fr);gap:15px;align-items:center;padding:20px;border-color:rgba(116,51,68,.21);background:radial-gradient(circle at 90% 4%,rgba(201,170,114,.17),transparent 34%),linear-gradient(135deg,rgba(116,51,68,.075),rgba(255,253,248,.92))}
      .location-hero>span{width:58px;height:58px;display:grid;place-items:center;border-radius:18px;background:#743344;color:#fffaf2}.location-hero>span .ui-icon{width:29px;height:29px}.location-hero h3{margin:3px 0 4px;font-size:28px}.location-hero p:not(.eyebrow){margin:0;color:var(--muted);font-size:11px}.location-hero a{width:max-content;display:inline-flex;align-items:center;gap:7px;min-height:38px;margin-top:11px;padding:8px 12px;border-radius:11px;background:linear-gradient(145deg,#ddb96f,#bc8d3e);color:#3f1a22;font-size:10px;font-weight:900;text-decoration:none}.location-hero a .ui-icon{width:16px;height:16px}
      .location-note{display:grid;grid-template-columns:38px minmax(0,1fr);gap:10px;align-items:start;margin-top:8px;padding:13px}.location-note>.ui-icon{width:24px;height:24px;color:#36556f}.location-note strong{display:block;font-size:13px}.location-note p{margin:3px 0 0;color:var(--muted);font-size:9px;line-height:1.4}
      @media(max-width:600px){.location-hero{grid-template-columns:45px minmax(0,1fr);padding:15px}.location-hero>span{width:43px;height:43px}.location-hero h3{font-size:22px}.location-hero a{width:100%;justify-content:center}}
    </style>`;
  }

  function renderSchedule() {
    const schedule = [
      { time: "18:00", title: "Llegada", detail: "Recepción de invitados." },
      { time: "18:30", title: "Ceremonia", detail: "El momento más esperado." },
      { time: "19:00", title: "Recepción + evento sorpresa", detail: "Comienza la experiencia." },
      { time: "21:00", title: "Cena y fiesta", detail: "A comer, brindar y bailar." },
      { time: "03:00", title: "Fin :)", detail: "Regreso y cierre de la celebración." }
    ];

    return `
      ${scheduleStyles()}
      ${sectionHeader("24 de octubre", "Cronograma", "Los momentos principales para que no te pierdas nada.")}

      <section class="schedule-card section-card">
        ${schedule.map((item, index) => `
          <article class="schedule-row ${index === schedule.length - 1 ? "is-last" : ""}">
            <time>${escapeHTML(item.time)}</time>
            <span><i></i></span>
            <div>
              <strong>${escapeHTML(item.title)}</strong>
              <p>${escapeHTML(item.detail)}</p>
            </div>
          </article>
        `).join("")}
      </section>`;
  }

  function scheduleStyles() {
    return `<style>
      .schedule-card{padding:11px 15px;background:linear-gradient(145deg,rgba(255,253,248,.93),rgba(239,228,209,.72))}
      .schedule-row{display:grid;grid-template-columns:61px 24px minmax(0,1fr);gap:9px;align-items:stretch;min-height:69px}.schedule-row time{padding-top:15px;color:#743344;font-family:var(--font-title);font-size:17px;font-weight:900;text-align:right}.schedule-row>span{position:relative;display:flex;justify-content:center}.schedule-row>span::after{content:"";position:absolute;top:31px;bottom:-1px;width:2px;background:linear-gradient(#c9aa72,rgba(201,170,114,.25))}.schedule-row.is-last>span::after{display:none}.schedule-row>span i{position:relative;z-index:1;width:13px;height:13px;margin-top:18px;border:3px solid #fffaf2;border-radius:50%;background:#743344;box-shadow:0 0 0 2px rgba(116,51,68,.17)}.schedule-row>div{align-self:start;margin-top:9px;padding:9px 12px;border:1px solid rgba(132,104,68,.11);border-radius:12px;background:rgba(255,255,255,.44)}.schedule-row strong{display:block;font-size:14px}.schedule-row p{margin:3px 0 0;color:var(--muted);font-size:9px}
      @media(max-width:500px){.schedule-card{padding:8px}.schedule-row{grid-template-columns:52px 20px minmax(0,1fr);gap:6px}.schedule-row time{font-size:15px}.schedule-row>div{padding:8px 10px}}
    </style>`;
  }


  function renderTravel() {
    const rsvp = state.rsvps[currentGuest.id] || {};
    const selectedTransport = String(rsvp.transport || "");
    const mode = ["combi", "micro"].includes(selectedTransport)
      ? "micro"
      : selectedTransport === "particular"
        ? "auto"
        : "";

    if (!mode) {
      return `
        ${travelStyles()}
        ${sectionHeader("día del casamiento", "En viaje", "La experiencia se adapta a la forma de traslado que elegiste.")}
        <section class="travel-choice-required section-card">
          <span>${uiIcon("bus")}</span>
          <div>
            <p class="eyebrow">Falta elegir el traslado</p>
            <h3>Confirmá cómo vas a viajar</h3>
            <p>Cuando selecciones Particular o Micro / Combi en Asistencia, esta sección mostrará automáticamente tu experiencia correspondiente.</p>
            <button type="button" data-go="asistencia">Ir a Asistencia</button>
          </div>
        </section>`;
    }

    const microMode = mode === "micro";

    return `
      ${travelStyles()}
      ${sectionHeader("día del casamiento", "En viaje", "Consignas y contenidos para disfrutar desde que empieza el recorrido.")}

      <section class="travel-selected-mode section-card ${microMode ? "is-micro" : "is-auto"}">
        <span>${uiIcon(microMode ? "bus" : "car")}</span>
        <div>
          <small>Tu opción de traslado</small>
          <strong>${microMode ? "Micro / Combi" : "Particular"}</strong>
        </div>
      </section>

      ${microMode ? `
        <section class="travel-hero section-card">
          <span>${uiIcon("bus")}</span>
          <div>
            <p class="eyebrow">Modo micro</p>
            <h3>La competencia empieza en el viaje</h3>
            <p>Acá aparecerán las consignas especiales para el micro, la playlist compartida y las trivias relámpago.</p>
          </div>
        </section>
        <section class="travel-content-grid">
          ${travelPlaceholder("music", "Playlist del micro", "Canciones para entrar en clima desde la salida.")}
          ${travelPlaceholder("question", "Trivias del camino", "Preguntas rápidas para sumar puntos en equipo.")}
          ${travelPlaceholder("star", "Consignas especiales", "Desafíos que se revelarán durante el recorrido.")}
        </section>
      ` : `
        <section class="travel-hero section-card travel-auto-hero">
          <span>${uiIcon("car")}</span>
          <div>
            <p class="eyebrow">Modo auto</p>
            <h3>También hay desafíos para el camino</h3>
            <p>Acá aparecerán la información para llegar, la playlist y las consignas pensadas para quienes viajan de forma particular.</p>
          </div>
        </section>
        <section class="travel-content-grid">
          ${travelPlaceholder("pin", "Cómo llegar", "La ubicación se habilitará el día de la boda.")}
          ${travelPlaceholder("music", "Playlist del viaje", "La música oficial para acompañar el recorrido.")}
          ${travelPlaceholder("star", "Desafíos desde el auto", "Consignas que podrán completar antes de llegar.")}
        </section>
      `}`;
  }


  function travelPlaceholder(icon, title, text) {
    return `
      <article class="section-card travel-placeholder">
        <span>${uiIcon(icon)}</span>
        <div><small>Próximamente</small><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p></div>
      </article>`;
  }

  function travelStyles() {
    return `<style>
      .travel-mode-selector{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:7px}.travel-mode-selector button{min-height:44px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid rgba(132,104,68,.13);border-radius:12px;background:rgba(255,255,255,.40);color:var(--muted);box-shadow:none;font-size:11px}.travel-mode-selector button.active{border-color:#743344;background:#743344;color:#fffaf2}.travel-mode-selector .ui-icon{width:18px;height:18px}
      .travel-hero{display:grid;grid-template-columns:52px minmax(0,1fr);gap:13px;align-items:center;margin-top:8px;padding:17px;background:linear-gradient(135deg,rgba(54,85,111,.09),rgba(255,253,248,.88));border-color:rgba(54,85,111,.18)}.travel-hero>span{width:50px;height:50px;display:grid;place-items:center;border-radius:15px;background:rgba(54,85,111,.10);color:#36556f}.travel-hero .ui-icon{width:25px;height:25px}.travel-hero h3{margin:3px 0 5px;font-size:23px}.travel-hero p:not(.eyebrow){margin:0;font-size:11px}.travel-auto-hero{background:linear-gradient(135deg,rgba(116,51,68,.07),rgba(255,253,248,.88));border-color:rgba(116,51,68,.17)}.travel-auto-hero>span{background:rgba(116,51,68,.09);color:#743344}
      .travel-content-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}.travel-placeholder{display:grid;grid-template-columns:35px minmax(0,1fr);gap:8px;align-items:start;padding:11px;opacity:.75}.travel-placeholder>span{width:33px;height:33px;display:grid;place-items:center;border-radius:10px;background:rgba(132,104,68,.08);color:#8b6939}.travel-placeholder .ui-icon{width:17px;height:17px}.travel-placeholder small,.travel-placeholder strong{display:block}.travel-placeholder small{color:#9b7139;font-size:7px;font-weight:900;text-transform:uppercase}.travel-placeholder strong{margin-top:2px;font-size:11px}.travel-placeholder p{margin:3px 0 0;font-size:8px;line-height:1.3}
      @media(max-width:650px){.travel-content-grid{grid-template-columns:1fr}.travel-hero{grid-template-columns:43px minmax(0,1fr);padding:13px}.travel-hero>span{width:41px;height:41px}.travel-hero h3{font-size:19px}}
    </style>`;
  }

  function renderRules() {
    const teamPoints = rsvpPointsForTeam(currentGuest.team);

    return `
      ${rulesStyles()}
      <button type="button" class="rules-back-to-points" data-go="puntos">
        ${uiIcon("arrowLeft")}<span>Volver a Sumá puntos</span>
      </button>
      ${sectionHeader("competencia", "Reglas", "Cómo se suman y restan puntos durante toda la experiencia.")}

      <section class="rules-intro section-card">
        <span>${uiIcon("ranking")}</span>
        <div>
          <p class="eyebrow">¿Por qué competir?</p>
          <h3>Seis equipos, una sola celebración</h3>
          <p>La competencia está pensada para que todos participen, se conozcan y lleguen a la fiesta con ganas de jugar. Los puntos son grupales y las acciones previas están equilibradas según la cantidad de integrantes de cada equipo.</p>
        </div>
      </section>

      <section class="section-card rules-table-card">
        <div class="rules-table-head">
          <span>Acción</span><span>Puntos</span><span>Cómo funciona</span>
        </div>

        ${rulesRow("Confirmar asistencia", `+${teamPoints}`, "Respuesta definitiva por sí o por no. El valor está equilibrado por equipo.")}
        ${rulesRow("Elegir canciones", `+${teamPoints}`, "Completar la propuesta musical para la boda y la entrada del equipo.")}
        ${rulesRow("Viajar en micro", "+20", "Bonus adicional para quienes seleccionen el micro en Asistencia.")}
        ${rulesRow("Trivia de los novios", "+20 por acierto", "Cinco preguntas, con un máximo de 100 puntos.")}
        ${rulesRow("Trivia Vani o Fede", "+20 por acierto", "Cinco preguntas, con un máximo de 100 puntos.")}
        ${rulesRow("Próximos desafíos", "Según consigna", "Cada actividad indicará cuántos puntos entrega.")}
        ${rulesRow("Bonus o penalizaciones", "+ / −", "Vani y Fede podrán sumar o restar puntos por juegos, actitud o incumplimiento de consignas.")}
      </section>

      <p class="rules-note">Los puntos se acreditan al equipo. No existe un ranking individual.</p>`;
  }

  function rulesRow(action, points, detail) {
    return `
      <div class="rules-table-row">
        <strong>${escapeHTML(action)}</strong>
        <b>${escapeHTML(points)}</b>
        <p>${escapeHTML(detail)}</p>
      </div>`;
  }

  function rulesStyles() {
    return `<style>
      .rules-intro{display:grid;grid-template-columns:54px minmax(0,1fr);gap:13px;align-items:center;padding:17px;background:linear-gradient(135deg,rgba(201,170,114,.11),rgba(255,253,248,.90));border-color:rgba(201,170,114,.26)}.rules-intro>span{width:51px;height:51px;display:grid;place-items:center;border-radius:15px;background:rgba(201,170,114,.15);color:#8b642c}.rules-intro .ui-icon{width:25px;height:25px}.rules-intro h3{margin:3px 0 5px;font-size:23px}.rules-intro p:not(.eyebrow){margin:0;font-size:11px;line-height:1.4}
      .rules-table-card{margin-top:8px;padding:9px}.rules-table-head,.rules-table-row{display:grid;grid-template-columns:minmax(130px,.9fr) 105px minmax(180px,1.5fr);gap:9px;align-items:center}.rules-table-head{padding:6px 9px;color:#8b642c;font-size:8px;font-weight:950;text-transform:uppercase;letter-spacing:.08em}.rules-table-row{min-height:52px;padding:8px 9px;border-top:1px solid rgba(132,104,68,.10)}.rules-table-row strong{font-size:11px}.rules-table-row b{color:#743344;font-size:11px}.rules-table-row p{margin:0;color:var(--muted);font-size:9px;line-height:1.3}.rules-note{margin:7px 2px 0;color:var(--muted);font-size:9px;text-align:center}
      @media(max-width:650px){
        .rules-intro{grid-template-columns:42px minmax(0,1fr);padding:13px}
        .rules-intro>span{width:40px;height:40px}
        .rules-intro h3{font-size:19px}
        .rules-table-card{overflow:visible;padding:7px;background:transparent;border:0;box-shadow:none}
        .rules-table-head{display:none}
        .rules-table-row{min-width:0;grid-template-columns:minmax(0,1fr) auto;gap:5px 9px;min-height:0;margin-bottom:7px;padding:10px 11px;border:1px solid rgba(132,104,68,.12);border-radius:12px;background:rgba(255,253,248,.78)}
        .rules-table-row strong{font-size:11px}
        .rules-table-row b{text-align:right;font-size:10px}
        .rules-table-row p{grid-column:1/-1;font-size:8.5px;line-height:1.35}
      }
    </style>`;
  }


  const GIFT_DETAILS = {
    alias: "NOVIO.NOVIA.BODA",
    cbu: "0000000000000000000000",
    holder: "Nombre Apellido",
    paymentUrl: ""
  };

  function renderGifts() {
    const paymentEnabled = Boolean(GIFT_DETAILS.paymentUrl);

    return `
      ${giftStyles()}
      ${sectionHeader("casamiento", "Regalos", "")}

      <section class="gift-hero section-card">
        <span>${uiIcon("gift")}</span>
        <div>
          <p class="eyebrow">Gracias por acompañarnos</p>
          <h3>Nuestro mejor regalo es compartir este día con vos 🥂</h3>
          <p>Tu presencia en el casamiento es lo más importante para nosotros.</p>
          <p>Además, si querés hacernos un regalo y ayudarnos a seguir sumando aventuras en nuestra <strong>Luna de Miel</strong>, podés hacerlo de la manera que te resulte más cómoda.</p>
        </div>
      </section>

      <section class="gift-options">
        <article class="gift-bank-card section-card">
          <div class="gift-card-heading">
            <span>${uiIcon("download")}</span>
            <div><small>Opción 1</small><h4>Transferencia bancaria</h4></div>
          </div>

          ${giftDetailRow("Alias", GIFT_DETAILS.alias, "alias")}
          ${giftDetailRow("CBU / CVU", GIFT_DETAILS.cbu, "cbu")}
          ${giftDetailRow("Titular", GIFT_DETAILS.holder, "")}
        </article>

        <article class="gift-payment-card section-card">
          <div class="gift-card-heading">
            <span>${uiIcon("phone")}</span>
            <div><small>Opción 2</small><h4>Mercado Pago / MODO</h4></div>
          </div>

          <p>También podés realizar el regalo escaneando nuestro código QR o ingresando desde el siguiente botón.</p>

          <div class="gift-qr-placeholder">
            ${uiIcon("gift")}
            <strong>QR próximamente</strong>
            <small>Acá aparecerá el código de pago.</small>
          </div>

          ${paymentEnabled
            ? `<a href="${escapeHTML(GIFT_DETAILS.paymentUrl)}" target="_blank" rel="noopener">Hacer un regalo</a>`
            : `<button type="button" disabled>Enlace próximamente</button>`}
        </article>
      </section>

      <p class="gift-thanks">Gracias por acompañarnos y ser parte de este momento tan especial 🤍</p>`;
  }

  function giftDetailRow(label, value, copyKey) {
    return `
      <div class="gift-detail-row">
        <div><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></div>
        ${copyKey
          ? `<button type="button" data-copy-gift="${escapeHTML(copyKey)}">Copiar</button>`
          : ""}
      </div>`;
  }


  function giftStyles() {
    return `<style>
      .gift-placeholder{display:grid;grid-template-columns:74px minmax(0,1fr);gap:17px;align-items:center;padding:23px;background:linear-gradient(135deg,rgba(201,170,114,.12),rgba(255,253,248,.90));border-color:rgba(201,170,114,.30)}.gift-placeholder-icon{width:68px;height:68px;display:grid;place-items:center;border-radius:21px;background:rgba(201,170,114,.14);color:#8d642d}.gift-placeholder-icon .ui-icon{width:34px;height:34px}.gift-placeholder h3{margin:4px 0 6px;font-size:27px}.gift-placeholder p:not(.eyebrow){margin:0;max-width:650px;font-size:12px}
      @media(max-width:560px){.gift-placeholder{grid-template-columns:54px minmax(0,1fr);padding:16px}.gift-placeholder-icon{width:51px;height:51px;border-radius:16px}.gift-placeholder-icon .ui-icon{width:27px;height:27px}.gift-placeholder h3{font-size:21px}}
    </style>`;
  }

  async function submitSocialMessage(form, parentId = "") {
    const textarea = form.querySelector('textarea[name="message"]');
    const message = String(textarea?.value || "").trim();

    if (!message) {
      toast("Escribí un mensaje antes de publicar.");
      textarea?.focus();
      return;
    }

    const payload = {
      messageId: newSocialMessageId(),
      parentId,
      guestId: currentGuest.id,
      guestName: guestFullName(currentGuest),
      teamId: currentGuest.team,
      message: message.slice(0, 400),
      updatedAt: new Date().toISOString()
    };

    form.reset();
    void queueOptimisticWrite(
      "saveSocialMessage",
      payload,
      {
        writeKey: `social:${payload.messageId}`,
        successMessage: parentId ? "Respuesta publicada." : "Mensaje publicado.",
        beforeRender: () => toast(parentId ? "Respuesta publicada. Guardando…" : "Mensaje publicado. Guardando…")
      }
    );
  }


  function scoreEntriesForGames(gameIds) {
    const ids = Array.isArray(gameIds) ? gameIds : [gameIds];
    const totals = Object.keys(DATA.teams).map(id => ({ id, total: 0 }));
    for (const entry of state.scoreEntries || []) {
      if (!ids.includes(entry.gameId)) continue;
      const row = totals.find(item => item.id === entry.teamId);
      if (row) row.total += Number(entry.points || 0);
    }
    return totals;
  }

  function currentRankingTotals() {
    const totals = Object.keys(DATA.teams).map(id => ({ id, total: 0 }));
    for (const entry of allPointEntries()) {
      const row = totals.find(item => item.id === entry.teamId);
      if (row) row.total += Number(entry.points || 0);
    }
    return totals;
  }

  function resetButtonStyles() {
    return `<style>
      .admin-reset-panel{border-color:rgba(255,180,168,.32);background:linear-gradient(135deg,rgba(255,180,168,.08),rgba(24,39,25,.82))}
      .admin-reset-panel h4{margin-bottom:8px}.admin-reset-panel p{color:var(--muted);font-weight:800;line-height:1.45}
      .admin-reset-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.admin-reset-actions .danger-button{border-color:rgba(255,180,168,.38)}
      .reset-note{margin-top:12px;color:rgba(247,238,217,.62);font-size:13px;font-weight:800}
    </style>`;
  }

  function adminGuestListData(type) {
    const guests = DATA.guests.filter(isCompetitionGuest);
    const definitions = {
      attending: { title: "Confirmaron asistencia", filter: guest => hasCompletedRsvp(state.rsvps[guest.id]) && state.rsvps[guest.id].attendance === "si", detail: guest => `Equipo ${getTeam(guest.team).name} · Asiste` },
      answered: { title: "Respondieron la invitación", filter: guest => hasCompletedRsvp(state.rsvps[guest.id]), detail: guest => `Equipo ${getTeam(guest.team).name} · ${attendanceLabel(state.rsvps[guest.id]?.attendance)}` },
      declined: { title: "No asistirán", filter: guest => hasCompletedRsvp(state.rsvps[guest.id]) && state.rsvps[guest.id].attendance === "no", detail: guest => `Equipo ${getTeam(guest.team).name} · No asiste` },
      unanswered: { title: "Todavía no respondieron", filter: guest => !hasCompletedRsvp(state.rsvps[guest.id]), detail: guest => `Equipo ${getTeam(guest.team).name} · Pendiente` },
      micro: { title: "Necesitan información del micro", filter: guest => { const row = state.rsvps[guest.id]; return hasCompletedRsvp(row) && row.attendance === "si" && ["combi","micro"].includes(row.transport); }, detail: guest => `Equipo ${getTeam(guest.team).name} · Micro desde el Obelisco` },
      restrictions: {
        title: "Restricciones alimentarias",
        filter: guest => {
          const row = state.rsvps[guest.id];
          return hasCompletedRsvp(row) && (
            row.dietChoice === "si" ||
            Boolean(String(row.diet || "").trim())
          );
        },
        detail: guest => {
          const row = state.rsvps[guest.id] || {};
          const restriction = String(row.diet || "").trim() || "Restricción sin detalle";
          return `Equipo ${getTeam(guest.team).name} · ${restriction}`;
        }
      }
    };
    const definition = definitions[type] || definitions.answered;
    return { title: definition.title, guests: guests.filter(definition.filter).sort((x,y)=>guestFullName(x).localeCompare(guestFullName(y),"es")), detail: definition.detail };
  }

  function renderAdminPeopleModal() {
    return `<div id="adminPeopleModal" class="admin-people-modal hidden" role="dialog" aria-modal="true" aria-labelledby="adminPeopleTitle"><div class="admin-people-dialog"><div class="admin-people-head"><div><p class="eyebrow">Detalle</p><h4 id="adminPeopleTitle">Personas</h4><p id="adminPeopleCount"></p></div><button type="button" class="admin-people-close" data-admin-modal-close aria-label="Cerrar">×</button></div><div id="adminPeopleList" class="admin-people-list"></div><button type="button" class="ghost-button admin-people-done" data-admin-modal-close>Cerrar</button></div></div>`;
  }

  function movementActor(entry) {
    if (entry?.adminName) return entry.adminName;
    if (entry?.guestName) return entry.guestName;

    const commentParts = String(entry?.comment || "")
      .split("·")
      .map(part => part.trim())
      .filter(Boolean);

    if (commentParts.length > 1) {
      const candidate = /puntos?$/i.test(commentParts[commentParts.length - 1])
        ? commentParts[commentParts.length - 2]
        : commentParts[commentParts.length - 1];

      if (candidate && !/^(reset|limpieza|general)$/i.test(candidate)) {
        return candidate;
      }
    }

    return entry?.automatic ? "Sistema" : "Vani y Fede";
  }


  function renderAdminMovements() {
    const entries = allPointEntries().slice(-12).reverse();

    return `
      <section class="section-card admin-movements admin-movements-compact">
        <div class="card-title-row">
          <div><p class="eyebrow">Auditoría</p><h4>Movimientos recientes</h4></div>
          <span class="badge">${entries.length}</span>
        </div>

        ${entries.length
          ? `<div class="admin-movement-list">
              ${entries.map(entry => {
                const points = Number(entry.points || 0);
                const team = getTeam(entry.teamId);
                const movementName = gameName(entry.gameId);
                const actor = movementActor(entry);

                return `
                  <article>
                    <span>${points >= 0 ? "+" : "−"}</span>
                    <div>
                      <strong>${escapeHTML(team.name)} · ${escapeHTML(movementName)}</strong>
                      <small>${escapeHTML(actor)} · ${escapeHTML(formatDateLabel(entry.timestamp || entry.submittedAt || entry.updatedAt))}</small>
                    </div>
                    <b>${Math.abs(points)} pts</b>
                  </article>`;
              }).join("")}
            </div>`
          : `<p class="admin-movement-empty">Todavía no hay movimientos.</p>`}
      </section>`;
  }



  function cleanBackupRecord(record = {}) {
    const clean = { ...record };
    delete clean.pendingSync;
    delete clean.pendingRequestId;
    delete clean.syncError;
    return clean;
  }

  function mapBackupObject(records = {}) {
    return Object.fromEntries(
      Object.entries(records || {}).map(([key, record]) => [
        key,
        cleanBackupRecord(record)
      ])
    );
  }

  function currentBackupPayload() {
    return {
      format: "vani-fede-backup-v1",
      createdAt: new Date().toISOString(),
      frontendVersion: CURRENT_APP_VERSION,
      backendVersion: state.backendVersion || "",
      appSettings: state.appSettings,
      data: {
        rsvps: mapBackupObject(state.rsvps),
        profiles: mapBackupObject(state.profiles),
        gameSubmissions: mapBackupObject(state.gameSubmissions),
        scoreEntries: (state.scoreEntries || []).map(cleanBackupRecord),
        socialMessages: (state.socialMessages || []).map(cleanBackupRecord),
        socialLikes: mapBackupObject(state.socialLikes),
        notificationsByGuest: mapBackupObject(state.notificationsByGuest),
        manualUnlocks: state.manualUnlocks
      }
    };
  }

  function downloadJsonFile(filename, payload) {
    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: "application/json;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadFullBackup() {
    const button = $("#downloadFullBackup");
    if (button) {
      button.disabled = true;
      button.textContent = "Preparando…";
    }

    await retryPendingWrites();
    await syncFromSheets(false);
    const payload = currentBackupPayload();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJsonFile(
      `vani-fede-backup-${appMode()}-${stamp}.json`,
      payload
    );
    localStorage.setItem(LAST_BACKUP_KEY, payload.createdAt);
    toast("Backup completo descargado.");
    renderCurrentRoute();
  }

  function backupOperations(backup) {
    const data = backup?.data || {};
    const operations = [];

    Object.values(data.rsvps || {}).forEach(record => operations.push({ action: "saveRsvp", record }));
    Object.values(data.profiles || {}).forEach(record => operations.push({ action: "saveProfile", record }));
    Object.values(data.gameSubmissions || {}).forEach(record => operations.push({ action: "saveGameSubmission", record }));
    (data.scoreEntries || []).forEach(record => operations.push({ action: "saveScore", record }));
    (data.socialMessages || []).forEach(record => operations.push({ action: "saveSocialMessage", record }));
    Object.values(data.socialLikes || {}).forEach(record => operations.push({ action: "saveSocialLike", record }));
    Object.values(data.notificationsByGuest || {}).forEach(record => operations.push({ action: "saveNotificationState", record }));
    Object.entries(data.manualUnlocks || {}).forEach(([key, open]) => operations.push({ action: "saveUnlock", record: { key, open } }));

    return operations;
  }

  async function restoreBackupFile(file) {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (_) {
      toast("El archivo no es un backup JSON válido.");
      return;
    }

    if (backup?.format !== "vani-fede-backup-v1") {
      toast("El archivo no corresponde a esta app.");
      return;
    }

    const operations = backupOperations(backup);
    if (!operations.length) {
      toast("El backup no contiene registros.");
      return;
    }

    const word = prompt(
      `Se restaurarán ${operations.length} registros dentro de ${isTestMode() ? "MODO PRUEBA" : "PRODUCTIVO"}. Escribí RESTAURAR para continuar.`
    );
    if (normalize(word) !== "restaurar") {
      toast("Restauración cancelada.");
      return;
    }

    const progress = $("#backupRestoreProgress");
    const input = $("#restoreBackupInput");
    const chunkSize = 5;
    let restored = 0;

    if (progress) progress.textContent = `Restaurando 0 de ${operations.length}…`;

    for (let index = 0; index < operations.length; index += chunkSize) {
      const chunk = operations.slice(index, index + chunkSize);
      const result = await writeToSheets(
        "restoreBackupChunk",
        {
          adminPassword: state.adminPassword,
          operations: chunk
        },
        { silent: true, allowPreview: true }
      );

      if (!result) {
        if (progress) progress.textContent = `Se detuvo en ${restored} de ${operations.length}.`;
        toast("La restauración se interrumpió. Podés volver a intentar.");
        if (input) input.value = "";
        return;
      }

      restored += chunk.length;
      if (progress) progress.textContent = `Restaurando ${restored} de ${operations.length}…`;
    }

    if (backup.appSettings) {
      await writeToSheets(
        "saveAppSettings",
        {
          adminPassword: state.adminPassword,
          settings: {
            ...backup.appSettings,
            mode: appMode()
          }
        },
        { silent: true, allowPreview: true }
      );
    }

    await syncFromSheets(false);
    if (progress) progress.textContent = `Restauración completa: ${restored} registros.`;
    if (input) input.value = "";
    toast("Backup restaurado correctamente.");
    renderCurrentRoute();
  }

  function renderAdmin() {
    if (!state.adminUnlocked) {
      return `
        ${adminAccessStyles()}
        <section class="admin-access-card section-card">
          <div class="admin-access-icon">${uiIcon("lock")}</div>
          <div class="admin-access-copy">
            <p class="eyebrow">Acceso restringido</p>
            <h3>Administración</h3>
            <p>Ingresá la contraseña para acceder al centro de mando.</p>
          </div>
          <form id="adminLoginForm" class="admin-access-form" autocomplete="off">
            <label for="adminPasswordInput">Contraseña</label>
            <div class="admin-password-row">
              <input id="adminPasswordInput" name="password" type="password"
                     placeholder="Ingresá la contraseña"
                     autocomplete="current-password" required>
              <button type="submit">Ingresar</button>
            </div>
            <div id="adminLoginMessage" class="form-message"
                 role="status" aria-live="polite"></div>
          </form>
        </section>`;
    }

    const invitedGuests = DATA.guests.filter(isCompetitionGuest);
    const invitedCount = invitedGuests.length;
    const attendingCount = invitedGuests.filter(guest => {
      const rsvp = state.rsvps[guest.id];
      return hasCompletedRsvp(rsvp) && rsvp.attendance === "si";
    }).length;
    const declinedCount = invitedGuests.filter(guest => {
      const rsvp = state.rsvps[guest.id];
      return hasCompletedRsvp(rsvp) && rsvp.attendance === "no";
    }).length;
    const answeredCount = invitedGuests.filter(guest => hasCompletedRsvp(state.rsvps[guest.id])).length;
    const unansweredCount = Math.max(0, invitedCount - answeredCount);
    const attendancePercent = invitedCount ? Math.round((attendingCount / invitedCount) * 100) : 0;
    const answeredPercent = invitedCount ? Math.round((answeredCount / invitedCount) * 100) : 0;
    const combiCount = invitedGuests.filter(guest => {
      const rsvp = state.rsvps[guest.id];
      return hasCompletedRsvp(rsvp) && rsvp.attendance === "si" && ["combi", "micro"].includes(rsvp.transport);
    }).length;
    const restrictionsCount = invitedGuests.filter(guest => {
      const rsvp = state.rsvps[guest.id];
      return hasCompletedRsvp(rsvp) && (
        rsvp.dietChoice === "si" ||
        Boolean(String(rsvp.diet || "").trim())
      );
    }).length;
    const socialMessageCount = dedupeSocialMessages(state.socialMessages || []).length;

    return `
      ${adminUxStyles()}
      <section class="admin-title-row">
        ${sectionHeader("admin", "Administración", "")}
        <button id="lockAdminButton" type="button" class="admin-lock-button">
          ${uiIcon("lock")}<span>Bloquear</span>
        </button>
      </section>

      <section class="admin-sync-card ${remoteStatus}">
        <div class="admin-sync-indicator"><span></span></div>
        <div>
          <small>Base de datos</small>
          <strong>${remoteStatus === "online" ? "Datos al día" : remoteStatus === "connecting" ? "Sincronizando…" : remoteStatus === "error" ? "Error de conexión" : isConfigured() ? "Pendiente de sincronización" : "No configurado"}</strong>
          <p>${state.lastSyncAt ? `Última sincronización: ${formatDateLabel(state.lastSyncAt)}` : "Todavía no se registró una sincronización en este navegador."}</p>
          <small class="admin-global-config-status">
            ${state.lastUnlockSyncAt
              ? `Configuración global: ${formatDateLabel(state.lastUnlockSyncAt)}`
              : "Configuración global pendiente"}
          </small>
          <div class="admin-version-grid">
            <span>Frontend <b>v${CURRENT_APP_VERSION}</b></span>
            <span>Backend <b>${escapeHTML(state.backendVersion || "pendiente")}</b></span>
            <span>Entorno <b>${isTestMode() ? "PRUEBA" : "PRODUCTIVO"}</b></span>
            <span>Pendientes <b>${pendingWrites.length}</b></span>
          </div>
        </div>
        <button id="syncNow" type="button">${uiIcon("sync")}<span>Sincronizar ahora</span></button>
      </section>

      <section class="admin-stability-grid">
        <article class="section-card admin-mode-panel ${isTestMode() ? "is-test" : "is-production"}">
          <div><p class="eyebrow">Entorno de datos</p><h4>${isTestMode() ? "Modo prueba" : "Modo productivo"}</h4><p>${isTestMode() ? "Los datos de prueba están separados de los reales." : "Los invitados están usando la base oficial."}</p></div>
          <div class="admin-mode-actions">
            <button type="button" data-set-app-mode="test" class="${isTestMode() ? "active" : ""}">Prueba</button>
            <button type="button" data-set-app-mode="production" class="${!isTestMode() ? "active" : ""}">Productivo</button>
          </div>
        </article>

        <article class="section-card admin-settings-panel">
          <div><p class="eyebrow">Seguridad y día del evento</p><h4>Configuración global</h4></div>
          <label class="admin-setting-toggle">
            <span><strong>Ingreso privado</strong><small>Oculta sugerencias y exige nombre completo.</small></span>
            <input type="checkbox" data-app-setting="loginPrivacyMode" ${state.appSettings?.loginPrivacyMode ? "checked" : ""}>
            <i></i>
          </label>
          <label class="admin-setting-toggle">
            <span><strong>Forzar modo día del casamiento</strong><small>Prioriza ubicación, cronograma y traslado en Inicio.</small></span>
            <input type="checkbox" data-app-setting="forceWeddingDay" ${state.appSettings?.forceWeddingDay ? "checked" : ""}>
            <i></i>
          </label>
        </article>
      </section>

      <section class="section-card admin-preview-panel">
        <div><p class="eyebrow">Control de calidad</p><h4>Ver la app como invitado</h4><p>La vista es de solo lectura: no modifica asistencia, juegos ni mensajes.</p></div>
        <div class="admin-preview-controls">
          <select id="adminPreviewGuestSelect">
            <option value="">Elegí un invitado…</option>
            ${invitedGuests.slice().sort(sortGuestsForDisplay).map(guest => `<option value="${escapeHTML(guest.id)}">${escapeHTML(guestFullName(guest))} · ${escapeHTML(getTeam(guest.team).name)}</option>`).join("")}
          </select>
          <button id="startAdminPreview" type="button">Abrir vista previa</button>
        </div>
      </section>

      <section class="section-card admin-backup-panel">
        <div class="admin-backup-copy"><span>${uiIcon("download")}</span><div><p class="eyebrow">Respaldo</p><h4>Backup completo</h4><p>RSVP, juegos, puntos, Social, candados y estados actuales.</p><small>Último backup en este navegador: ${localStorage.getItem(LAST_BACKUP_KEY) ? formatDateLabel(localStorage.getItem(LAST_BACKUP_KEY)) : "todavía no realizado"}</small></div></div>
        <div class="admin-backup-actions">
          <button id="downloadFullBackup" type="button">Descargar backup</button>
          <label class="admin-restore-label">Restaurar backup<input id="restoreBackupInput" type="file" accept="application/json,.json"></label>
        </div>
        <p id="backupRestoreProgress" class="admin-backup-progress"></p>
      </section>

      <section class="admin-attendance-summary">
        <button type="button" class="admin-stat-button" data-admin-list="attending"><span>✓</span><div><small>Asisten</small><strong>${attendingCount}</strong><em>Ver</em></div></button>
        <button type="button" class="admin-stat-button" data-admin-list="answered"><span>%</span><div><small>Respondieron</small><strong>${answeredCount}</strong><em>${answeredPercent}%</em></div></button>
        <button type="button" class="admin-stat-button" data-admin-list="declined"><span>−</span><div><small>No asisten</small><strong>${declinedCount}</strong><em>Ver</em></div></button>
        <button type="button" class="admin-stat-button" data-admin-list="unanswered"><span>?</span><div><small>Pendientes</small><strong>${unansweredCount}</strong><em>Ver</em></div></button>
        <button type="button" class="admin-stat-button admin-combi-stat" data-admin-list="micro"><span>${uiIcon("bus")}</span><div><small>Micro</small><strong>${combiCount}</strong><em>Ver</em></div></button>
        <button type="button" class="admin-stat-button admin-restrictions-stat" data-admin-list="restrictions"><span>${uiIcon("food")}</span><div><small>Restricciones</small><strong>${restrictionsCount}</strong><em>Ver detalle</em></div></button>
      </section>
      ${renderAdminPeopleModal()}

      <form id="scoreForm" class="section-card admin-score-card">
        <div class="admin-score-heading">
          <div>
            <p class="eyebrow">Ajuste discrecional</p>
            <h4>Sumar o restar puntos</h4>
            <p>Carga rápida de puntos.</p>
          </div>
          <span id="adminScorePreview" class="admin-score-preview">Seleccioná un equipo</span>
        </div>

        <input type="hidden" name="gameId" value="discrecional-fede-vani">

        <fieldset class="admin-score-fieldset">
          <legend>1. Equipo</legend>
          <div class="admin-team-picker">
            ${Object.values(DATA.teams).map(team => `
              <label class="admin-team-option" style="--local-accent:${team.accent}">
                <input type="radio" name="teamId" value="${team.id}" required>
                ${teamLogo(team, "admin-team-logo")}
                <span>${escapeHTML(team.name)}</span>
              </label>`).join("")}
          </div>
        </fieldset>

        <fieldset class="admin-score-fieldset">
          <legend>2. Movimiento</legend>
          <div class="admin-sign-picker">
            <label>
              <input type="radio" name="scoreSign" value="1" checked>
              <span>＋ Sumar</span>
            </label>
            <label>
              <input type="radio" name="scoreSign" value="-1">
              <span>− Restar</span>
            </label>
          </div>
        </fieldset>

        <fieldset class="admin-score-fieldset">
          <legend>3. Cantidad</legend>
          <div class="admin-points-input">
            <input name="points" type="number" min="1" step="1" inputmode="numeric" placeholder="Ej: 50" required>
            <span>puntos</span>
          </div>
          <div class="admin-preset-row" aria-label="Cantidades rápidas">
            ${[10, 25, 50, 100].map(value => `<button type="button" data-score-preset="${value}">${value}</button>`).join("")}
          </div>
        </fieldset>

        <label class="admin-comment-label">
          Motivo <span>(opcional)</span>
          <textarea name="comment" placeholder="Ej: ganó un juego, bonus por actitud o penalización..."></textarea>
        </label>

        <button id="scoreSubmit" type="submit" class="admin-score-submit" disabled>Seleccioná un equipo y una cantidad</button>
      </form>

      <section class="section-card admin-official-export">
        <div class="admin-official-export-icon">${uiIcon("download")}</div>
        <div>
          <p class="eyebrow">Lista oficial</p>
          <h4>Exportar confirmados para el salón</h4>
          <p>Confirmados con contacto, traslado y restricciones.</p>
        </div>
        <button id="exportOfficialGuests" type="button">${uiIcon("download")}<span>Exportar CSV</span></button>
      </section>

      <section class="section-card admin-game-controls admin-section-controls">
        <div class="admin-game-controls-head">
          <div><p class="eyebrow">Secciones</p><h4>Bloquear o habilitar</h4></div>
        </div>
        <p class="admin-section-note">Inicio y Administración permanecen siempre disponibles.</p>
        <div class="admin-game-toggle-list admin-section-toggle-grid">
          ${SECTION_DEFINITIONS.map(section => {
            const open = isSectionOpen(section.route);
            return `
              <label class="admin-game-toggle ${open ? "is-open" : ""}">
                <span><strong>${escapeHTML(section.title)}</strong><small>${escapeHTML(section.text)}</small></span>
                <input type="checkbox" data-unlock-key="${escapeHTML(section.key)}" ${open ? "checked" : ""}>
                <i aria-hidden="true"></i>
                <b>${open ? "Visible" : "Bloqueada"}</b>
              </label>`;
          }).join("")}
        </div>
      </section>

      <section class="section-card admin-game-controls">
        <div class="admin-game-controls-head">
          <div><p class="eyebrow">Juegos</p><h4>Disponibilidad</h4></div>
        </div>
        <div class="admin-game-toggle-list">
          ${[
            { key: "trivia-music", title: "La banda sonora", text: "Canción para la boda y entrada del equipo." },
            { key: "trivia-couple", title: "¿Cuánto conocés a los novios?", text: "Cinco preguntas de opción múltiple." },
            { key: "trivia-who", title: "¿Quién es quién?", text: "Cinco preguntas Vani o Fede." }
          ].map(game => {
            const open = isTriviaGameOpen(game.key);
            return `<label class="admin-game-toggle ${open ? "is-open" : ""}">
              <span><strong>${escapeHTML(game.title)}</strong><small>${escapeHTML(game.text)}</small></span>
              <input type="checkbox" data-unlock-key="${game.key}" ${open ? "checked" : ""}>
              <i aria-hidden="true"></i>
              <b>${open ? "Liberado" : "Bloqueado"}</b>
            </label>`;
          }).join("")}
        </div>
      </section>



      ${resetButtonStyles()}

      <section class="section-card admin-social-reset-panel">
        <span class="admin-social-reset-icon">${uiIcon("chat")}</span>
        <div>
          <p class="eyebrow">Social</p>
          <h4>Vaciar mensajes</h4>
          <p>${socialMessageCount} ${socialMessageCount === 1 ? "mensaje publicado" : "mensajes publicados"}.</p>
        </div>
        <button id="clearSocialMessages" type="button" ${socialMessageCount ? "" : "disabled"}>Vaciar Social</button>
      </section>

      <section class="section-card admin-test-reset-panel">
        <div class="admin-test-reset-copy">
          <span class="admin-test-reset-icon" aria-hidden="true">↺</span>
          <div>
            <p class="eyebrow">Modo de pruebas</p>
            <h4>Resetear datos de prueba</h4>
            <p>Limpia RSVP, formularios y juegos.</p>
            <small>No borra invitados ni puntos discrecionales.</small>
          </div>
        </div>
        <button id="resetTestData" type="button" class="admin-test-reset-button" ${isTestMode() ? "" : "disabled"}>${isTestMode() ? "Resetear datos del modo prueba" : "Disponible solo en modo prueba"}</button>
      </section>

      <section class="section-card admin-reset-panel">
        <h4>Reseteo de puntos</h4>
        <p>No borra asistencias ni invitados.</p>
        <div class="admin-reset-actions">
          <button id="resetDiscretionaryPoints" type="button" class="danger-button">Resetear discrecionales</button>
          <button id="resetAllPoints" type="button" class="danger-button">Resetear todo el ranking</button>
        </div>
      </section>
      ${renderAdminMovements()}`;
  }

  function adminUxStyles() {
    return `<style>
      .admin-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
      .admin-title-row>.section-head{flex:1}
      .admin-lock-button{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;margin-top:8px;border:1px solid rgba(122,49,64,.22);background:rgba(255,255,255,.42);color:#743344;box-shadow:none}
      .admin-lock-button .ui-icon{width:17px;height:17px}
      .admin-sync-card{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:14px;align-items:center;padding:17px 19px;margin-bottom:15px;border:1px solid var(--line);border-radius:19px;background:rgba(255,253,248,.78)}.admin-sync-indicator{display:grid;place-items:center}.admin-sync-indicator span{width:11px;height:11px;border-radius:50%;background:#b68b45;box-shadow:0 0 0 5px rgba(182,139,69,.10)}.admin-sync-card.online .admin-sync-indicator span{background:#4f8655;box-shadow:0 0 0 5px rgba(79,134,85,.10)}.admin-sync-card.error .admin-sync-indicator span{background:#b9574d;box-shadow:0 0 0 5px rgba(185,87,77,.10)}.admin-sync-card.connecting .admin-sync-indicator span{animation:syncPulse 1s infinite}.admin-sync-card small,.admin-sync-card strong{display:block}.admin-sync-card small{color:var(--muted-2);font-weight:850}.admin-sync-card strong{margin-top:2px;color:var(--ink);font-size:16px}.admin-sync-card p{margin:2px 0 0;font-size:12px}.admin-sync-card button{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}.admin-sync-card button .ui-icon{width:18px;height:18px}@keyframes syncPulse{50%{opacity:.35;transform:scale(.78)}}
      .admin-game-controls{margin:15px 0;padding:22px}.admin-game-controls-head h4{margin:4px 0 6px;font-size:25px}.admin-game-controls-head p:not(.eyebrow){margin:0}.admin-game-toggle-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:17px}.admin-game-toggle{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;margin:0;padding:15px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.40);cursor:pointer}.admin-game-toggle>span strong,.admin-game-toggle>span small{display:block}.admin-game-toggle>span strong{color:var(--ink)}.admin-game-toggle>span small{margin-top:4px;line-height:1.35}.admin-game-toggle input{position:absolute;opacity:0;pointer-events:none}.admin-game-toggle i{grid-column:2;width:42px;height:24px;padding:3px;border-radius:999px;background:rgba(132,104,68,.20);transition:.18s}.admin-game-toggle i::after{content:"";display:block;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:.18s}.admin-game-toggle b{grid-column:1/-1;color:var(--muted-2);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.admin-game-toggle.is-open{border-color:rgba(74,125,79,.25);background:rgba(74,125,79,.06)}.admin-game-toggle.is-open i{background:#5d8e62}.admin-game-toggle.is-open i::after{transform:translateX(18px)}.admin-game-toggle.is-open b{color:#426f47}
      .admin-attendance-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
      .admin-attendance-summary article{display:grid;grid-template-columns:46px minmax(0,1fr);gap:12px;align-items:center;padding:18px;border:1px solid var(--line);border-radius:20px;background:rgba(255,253,248,.78);box-shadow:0 8px 20px rgba(76,51,22,.05)}
      .admin-attendance-summary article>span{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:rgba(122,49,64,.09);color:#743344;font-size:20px;font-weight:950}
      .admin-attendance-summary small{display:block;color:var(--muted-2);font-weight:850}.admin-attendance-summary strong{display:block;margin-top:2px;color:var(--ink);font-family:var(--font-title);font-size:29px}.admin-attendance-summary p{margin:1px 0 0;font-size:12px;line-height:1.35}
      .admin-official-export{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:16px;align-items:center;margin-top:15px;padding:20px 22px;border-color:rgba(74,125,79,.22);background:linear-gradient(135deg,rgba(74,125,79,.06),rgba(255,253,248,.86))}.admin-official-export-icon{width:50px;height:50px;display:grid;place-items:center;border-radius:15px;background:rgba(74,125,79,.10);color:#426f47}.admin-official-export-icon .ui-icon{width:24px;height:24px}.admin-official-export h4{margin:4px 0 5px;font-size:22px}.admin-official-export p:not(.eyebrow){margin:0;font-size:13px}.admin-official-export button{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}.admin-official-export button .ui-icon{width:18px;height:18px}
      .admin-score-card{display:grid;gap:22px;margin-top:16px;padding:26px}.admin-score-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.admin-score-heading h4{margin:5px 0 6px;font-size:28px}.admin-score-heading p{margin:0}.admin-score-preview{display:inline-flex;align-items:center;min-height:36px;padding:8px 12px;border-radius:999px;background:rgba(201,170,114,.13);color:var(--gold-deep);font-size:12px;font-weight:900;white-space:nowrap}
      .admin-score-fieldset{margin:0;padding:0;border:0}.admin-score-fieldset legend{margin-bottom:11px;color:var(--ink);font-weight:900}.admin-team-picker{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.admin-team-option{position:relative;display:grid;justify-items:center;gap:7px;min-height:104px;margin:0;padding:13px 8px;border:1px solid var(--line);border-radius:17px;background:rgba(255,255,255,.40);color:var(--ink);font-size:12px;font-weight:900;cursor:pointer;text-align:center}.admin-team-option input{position:absolute;opacity:0;pointer-events:none}.admin-team-option:has(input:checked){border-color:color-mix(in srgb,var(--local-accent) 65%,var(--line));background:color-mix(in srgb,var(--local-accent) 13%,rgba(255,255,255,.56));box-shadow:0 0 0 3px color-mix(in srgb,var(--local-accent) 12%,transparent)}.admin-team-logo{width:48px;height:48px}
      .admin-sign-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.admin-sign-picker label{position:relative;margin:0}.admin-sign-picker input{position:absolute;opacity:0;pointer-events:none}.admin-sign-picker span{display:flex;align-items:center;justify-content:center;min-height:49px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.42);color:var(--ink);font-weight:900;cursor:pointer}.admin-sign-picker label:first-child:has(input:checked) span{border-color:rgba(74,125,79,.35);background:rgba(74,125,79,.10);color:#426f47}.admin-sign-picker label:last-child:has(input:checked) span{border-color:rgba(185,87,77,.34);background:rgba(185,87,77,.09);color:#93463c}
      .admin-points-input{position:relative}.admin-points-input input{height:58px;margin:0;padding-right:80px;border-radius:15px;font-size:21px;font-weight:850}.admin-points-input>span{position:absolute;right:17px;top:50%;transform:translateY(-50%);color:var(--muted-2);font-size:13px;font-weight:850}.admin-preset-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.admin-preset-row button{min-width:64px;padding:9px 13px;border:1px solid var(--line);background:rgba(255,255,255,.45);color:var(--ink);box-shadow:none}.admin-comment-label{margin:0}.admin-comment-label>span{color:var(--muted-2);font-weight:600}.admin-comment-label textarea{min-height:85px}
      .admin-score-submit{width:100%;min-height:52px}.admin-score-submit.is-negative{background:linear-gradient(135deg,#c66b5d,#9d4138);color:#fff}.admin-score-submit:disabled{cursor:not-allowed;opacity:.48;transform:none}
      .admin-test-reset-panel{display:flex;align-items:center;justify-content:space-between;gap:22px;margin-top:16px;padding:22px;border-color:rgba(122,49,64,.20);background:linear-gradient(135deg,rgba(122,49,64,.055),rgba(255,253,248,.84))}
      .admin-test-reset-copy{display:grid;grid-template-columns:52px minmax(0,1fr);gap:15px;align-items:start}.admin-test-reset-icon{width:50px;height:50px;display:grid;place-items:center;border:1px solid rgba(122,49,64,.18);border-radius:15px;background:rgba(122,49,64,.08);color:#743344;font-size:25px;font-weight:900}.admin-test-reset-copy h4{margin:4px 0 6px;font-size:24px}.admin-test-reset-copy p:not(.eyebrow){margin:0;max-width:700px}.admin-test-reset-copy small{display:block;margin-top:7px;line-height:1.4}.admin-test-reset-button{min-height:48px;flex:0 0 auto;border:1px solid #743344;background:#743344;color:#fffaf0;box-shadow:0 8px 18px rgba(116,51,68,.13);white-space:nowrap}.admin-test-reset-button:hover{background:#652c3b}
      .team-page-actions{display:flex;gap:9px;margin-top:17px}.team-page-actions button,.ranking-action-card button{display:inline-flex;align-items:center;gap:8px}.team-page-actions .ui-icon,.ranking-action-card .ui-icon{width:19px;height:19px}
      .ranking-action-card{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 20px}.ranking-action-card strong{color:var(--ink);font-size:17px}.ranking-action-card p{margin:3px 0 0;font-size:13px}.ranking-action-card button{white-space:nowrap}.ranking-action-buttons{display:flex;gap:9px;align-items:center}.ranking-refresh-button{border:1px solid rgba(132,104,68,.24);background:rgba(255,255,255,.50);color:var(--ink);box-shadow:none}.ranking-action-buttons button{display:inline-flex;align-items:center;gap:8px}.ranking-action-buttons .ui-icon{width:18px;height:18px}
      @media(max-width:1100px){.admin-attendance-summary{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:900px){.admin-title-row{align-items:stretch;flex-direction:column}.admin-lock-button{width:100%;justify-content:center;margin-top:0}.admin-attendance-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.admin-team-picker{grid-template-columns:repeat(3,minmax(0,1fr))}.admin-game-toggle-list{grid-template-columns:1fr}.admin-sync-card{grid-template-columns:18px minmax(0,1fr)}.admin-sync-card button{grid-column:1/-1;width:100%;justify-content:center}}
      @media(max-width:560px){.admin-attendance-summary{grid-template-columns:1fr 1fr}.admin-combi-stat{grid-column:1/-1}.admin-official-export{grid-template-columns:44px minmax(0,1fr)}.admin-official-export-icon{width:42px;height:42px}.admin-official-export button{grid-column:1/-1;width:100%;justify-content:center}.admin-attendance-summary article{grid-template-columns:1fr;gap:7px;padding:14px}.admin-attendance-summary article>span{width:36px;height:36px}.admin-attendance-summary strong{font-size:25px}.admin-score-card{padding:18px}.admin-score-heading{display:grid}.admin-score-preview{width:max-content}.admin-team-picker{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-action-card{align-items:flex-start;flex-direction:column}.ranking-action-buttons{display:grid;width:100%;grid-template-columns:1fr 1fr}.ranking-action-card button,.team-page-actions button{width:100%;justify-content:center}.admin-test-reset-panel{align-items:stretch;flex-direction:column}.admin-test-reset-copy{grid-template-columns:44px minmax(0,1fr)}.admin-test-reset-icon{width:42px;height:42px}.admin-test-reset-button{width:100%;white-space:normal}}
    </style>`;
  }


  function renderTriviaAndFocus(targetId) {
    renderCurrentRoute();

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        document
          .getElementById(targetId)
          ?.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
      }, 40);
    });
  }

  function bindViewEvents(route) {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (route === "inicio") startHomeCountdown();

    $$('[data-go]').forEach(button => button.addEventListener("click", () => {
      if (button.dataset.go === "equipo") {
        selectedTeamViewId = currentGuest?.team || null;
        teamCommunityTab = "mine";
      }
      navigate(button.dataset.go);
    }));
    $$('[data-scroll]').forEach(button => button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.scroll);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));

    if (["equipo", "invitados"].includes(route)) {
      $$("[data-team-community-tab]").forEach(button => {
        button.addEventListener("click", () => {
          teamCommunityTab = button.dataset.teamCommunityTab === "all"
            ? "all"
            : "mine";

          if (currentRoute !== "equipo") {
            navigate("equipo");
          } else {
            renderCurrentRoute();
          }
        });
      });

      $$("[data-guest-team-toggle]").forEach(button => {
        button.addEventListener("click", () => {
          const teamId = button.dataset.guestTeamToggle;
          expandedGuestTeamId =
            expandedGuestTeamId === teamId
              ? ""
              : teamId;
          renderCurrentRoute();
        });
      });
    }

    if (route === "regalos") {
      $$("[data-copy-gift]").forEach(button => {
        button.addEventListener("click", async () => {
          const key = button.dataset.copyGift;
          const value = GIFT_DETAILS[key] || "";
          const copied = await copyText(value);
          toast(copied ? `${key === "alias" ? "Alias" : "CBU"} copiado.` : "No se pudo copiar.");
        });
      });
    }

    if (route === "ranking") {
      $("#refreshRanking")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        const original = button.innerHTML;

        button.disabled = true;
        button.classList.add("is-loading");
        button.innerHTML = `<span class="ranking-button-icon">${uiIcon("sync")}</span><span>Actualizando…</span>`;

        const [updated] = await Promise.all([
          syncFromSheets(false),
          new Promise(resolve => window.setTimeout(resolve, 650))
        ]);

        if (button.isConnected) {
          button.disabled = false;
          button.classList.remove("is-loading");
          button.innerHTML = original;
        }

        if (updated) {
          toast("Ranking actualizado con los últimos puntajes.");
        } else {
          toast("No se pudo actualizar. Se muestran los últimos datos disponibles.");
        }
      });
    }

    if (route === "asistencia") {
      const rsvpForm = $("#rsvpForm");
      const updateDietField = () => {
        if (!rsvpForm) return;
        const choice = rsvpForm.querySelector('input[name="dietChoice"]:checked')?.value || "";
        const label = rsvpForm.querySelector("[data-diet-detail]");
        const textarea = rsvpForm.querySelector('textarea[name="diet"]');
        if (!label || !textarea) return;

        const disabled = choice === "no";
        label.classList.toggle("is-disabled", disabled);
        textarea.disabled = disabled;
        textarea.required = choice === "si";

        const helper = label.querySelector("small");
        if (helper) {
          helper.textContent = disabled
            ? "No es necesario completar este campo."
            : "Completalo únicamente si marcaste Sí.";
        }

        if (disabled) textarea.value = "";
      };

      rsvpForm?.querySelectorAll('input[name="dietChoice"]').forEach(input => {
        input.addEventListener("change", updateDietField);
      });
      updateDietField();

      $("#editRsvp")?.addEventListener("click", () => {
        state.rsvpEditMode = true;
        saveState();
        renderCurrentRoute();
      });

      $("#cancelRsvpEdit")?.addEventListener("click", () => {
        state.rsvpEditMode = false;
        saveState();
        renderCurrentRoute();
      });

      $("#rsvpForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = Object.fromEntries(new FormData(form).entries());

        if (!["si", "no"].includes(values.attendance)) {
          toast("Elegí si vas a asistir.");
          return;
        }

        if (!["si", "no"].includes(values.dietChoice)) {
          toast("Indicá si tenés restricciones alimentarias.");
          return;
        }

        const diet = values.dietChoice === "si"
          ? String(values.diet || "").trim()
          : "";

        if (values.dietChoice === "si" && !diet) {
          toast("Detallá la restricción alimentaria.");
          form.querySelector('textarea[name="diet"]')?.focus();
          return;
        }

        const payload = {
          ...values,
          diet,
          comment: "",
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        state.rsvpEditMode = false;
        void queueOptimisticWrite(
          "saveRsvp",
          payload,
          {
            writeKey: `rsvp:${currentGuest.id}`,
            successMessage: "Asistencia confirmada.",
            beforeRender: () => {
              toast("Listo. Estamos guardando tu asistencia.");
            }
          }
        );
      });
    }

    if (route === "ficha") {
      $("#editProfile")?.addEventListener("click", () => {
        state.profileEditMode = true;
        saveState();
        renderCurrentRoute();
      });

      $("#cancelProfileEdit")?.addEventListener("click", () => {
        state.profileEditMode = false;
        saveState();
        renderCurrentRoute();
      });

      $("#profileForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = {
          ...values,
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        state.profileEditMode = false;
        void queueOptimisticWrite(
          "saveProfile",
          payload,
          {
            writeKey: `profile:${currentGuest.id}`,
            successMessage: "Formulario guardado.",
            beforeRender: () => toast("Listo. Se está guardando.")
          }
        );
      });
    }

    if (route === "puntos") {
      $$(".game-submit").forEach(form => form.addEventListener("submit", event => {
        event.preventDefault();
        const currentForm = event.currentTarget;
        const gameId = currentForm.dataset.gameId;
        const values = Object.fromEntries(new FormData(currentForm).entries());
        const payload = {
          ...values,
          gameId,
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        void queueOptimisticWrite(
          "saveGameSubmission",
          payload,
          {
            writeKey: `game:${currentGuest.id}:${gameId}`,
            successMessage: "Respuesta guardada.",
            beforeRender: () => toast("Respuesta recibida. Guardando…")
          }
        );
      }));
    }

    if (route === "trivia") {
      $("#editMusicGame")?.addEventListener("click", () => {
        musicEditMode = true;
        renderTriviaAndFocus("music-game");
      });

      $("#musicGameForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = {
          ...values,
          gameId: "music-selection",
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        musicEditMode = false;
        const earnedPoints = rsvpPointsForTeam(currentGuest.team);

        void queueOptimisticWrite(
          "saveGameSubmission",
          payload,
          {
            writeKey: `game:${currentGuest.id}:music-selection`,
            successMessage: `Canciones confirmadas. El equipo sumó ${earnedPoints} puntos.`,
            beforeRender: () => toast("Canciones recibidas. Guardando…"),
            afterRender: () => {
              window.requestAnimationFrame(() => {
                document.getElementById("couple-trivia-game")?.scrollIntoView({ behavior: "smooth", block: "center" });
              });
            }
          }
        );
      });

      $("#coupleTriviaForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const key = `${currentGuest.id}::couple-trivia-test`;
        if (state.gameSubmissions[key]) {
          toast("Esta trivia ya fue jugada. Podés ver tu resultado.");
          renderCurrentRoute();
          return;
        }

        const answers = Object.fromEntries(new FormData(event.currentTarget).entries());
        const score = SAMPLE_COUPLE_QUESTIONS.reduce(
          (total, question) => total + (answers[question.id] === question.answer ? 1 : 0),
          0
        );
        const payload = {
          answers,
          score,
          bestScore: score,
          earnedPoints: score * 20,
          maxScore: SAMPLE_COUPLE_QUESTIONS.length,
          gameId: "couple-trivia-test",
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        void queueOptimisticWrite(
          "saveGameSubmission",
          payload,
          {
            writeKey: `game:${currentGuest.id}:couple-trivia-test`,
            successMessage: `Trivia confirmada: ${score * 20} puntos.`,
            beforeRender: () => toast("Resultado calculado. Guardando…"),
            afterRender: () => {
              window.requestAnimationFrame(() => {
                document.getElementById("couple-trivia-result")?.scrollIntoView({ behavior: "smooth", block: "center" });
              });
            }
          }
        );
      });


      $("#whoIsWhoTriviaForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const key = `${currentGuest.id}::who-is-who-trivia-test`;
        if (state.gameSubmissions[key]) {
          toast("Esta trivia ya fue jugada. Podés ver tu resultado.");
          renderCurrentRoute();
          return;
        }

        const answers = Object.fromEntries(new FormData(event.currentTarget).entries());
        const score = WHO_IS_WHO_QUESTIONS.reduce(
          (total, question) => total + (answers[question.id] === question.answer ? 1 : 0),
          0
        );
        const payload = {
          answers,
          score,
          bestScore: score,
          earnedPoints: score * 20,
          maxScore: WHO_IS_WHO_QUESTIONS.length,
          gameId: "who-is-who-trivia-test",
          guestId: currentGuest.id,
          teamId: currentGuest.team,
          updatedAt: new Date().toISOString()
        };

        void queueOptimisticWrite(
          "saveGameSubmission",
          payload,
          {
            writeKey: `game:${currentGuest.id}:who-is-who-trivia-test`,
            successMessage: `Trivia confirmada: ${score * 20} puntos.`,
            beforeRender: () => toast("Resultado calculado. Guardando…"),
            afterRender: () => {
              window.requestAnimationFrame(() => {
                document.getElementById("trivia-upcoming-note")?.scrollIntoView({ behavior: "smooth", block: "center" });
              });
            }
          }
        );
      });
    }


    if (route === "social") {

      $$("[data-social-like]").forEach(button => {
        button.addEventListener("click", () => {
          const messageId = button.dataset.socialLike;
          if (!messageId || !currentGuest?.id) return;

          const active = !currentGuestLikesMessage(messageId);
          const payload = {
            messageId,
            guestId: currentGuest.id,
            guestName: guestFullName(currentGuest),
            teamId: currentGuest.team,
            active,
            updatedAt: new Date().toISOString()
          };

          void queueOptimisticWrite(
            "saveSocialLike",
            payload,
            {
              writeKey: `like:${messageId}:${currentGuest.id}`,
              render: true
            }
          );
        });
      });

      $("#refreshSocial")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        const original = button.innerHTML;

        button.disabled = true;
        button.classList.add("is-loading");
        button.innerHTML = `${uiIcon("sync")}<span>Actualizando…</span>`;

        const [updated] = await Promise.all([
          syncFromSheets(false),
          new Promise(resolve => window.setTimeout(resolve, 650))
        ]);

        if (button.isConnected) {
          button.disabled = false;
          button.classList.remove("is-loading");
          button.innerHTML = original;
        }

        if (updated) toast("Mensajes actualizados.");
        else toast("No se pudieron actualizar los mensajes.");
      });

      $("#socialPostForm")?.addEventListener("submit", event => {
        event.preventDefault();
        submitSocialMessage(event.currentTarget, "");
      });

      $$("[data-social-emoji]").forEach(button => {
        button.addEventListener("click", () => {
          const form = button.closest("form");
          const textarea = form?.querySelector('textarea[name="message"]');
          if (!textarea) return;

          const emoji = button.dataset.socialEmoji || "";
          const start = textarea.selectionStart ?? textarea.value.length;
          const end = textarea.selectionEnd ?? textarea.value.length;
          textarea.value = `${textarea.value.slice(0, start)}${emoji}${textarea.value.slice(end)}`;
          textarea.focus();
          textarea.setSelectionRange(start + emoji.length, start + emoji.length);
        });
      });

      $$('[data-social-reply]').forEach(button => {
        button.addEventListener("click", () => {
          const form = $$(".social-reply-form").find(item => item.dataset.socialParent === button.dataset.socialReply);
          if (!form) return;
          form.classList.toggle("hidden");
          if (!form.classList.contains("hidden")) form.querySelector("textarea")?.focus();
        });
      });

      $$('[data-social-cancel]').forEach(button => {
        button.addEventListener("click", () => {
          const form = button.closest(".social-reply-form");
          form?.classList.add("hidden");
          form?.reset();
        });
      });

      $$(".social-reply-form").forEach(form => {
        form.addEventListener("submit", event => {
          event.preventDefault();
          submitSocialMessage(event.currentTarget, event.currentTarget.dataset.socialParent || "");
        });
      });
    }

    if (route === "admin") bindAdminEvents();
  }


  function adminAccessStyles() {
    return `<style>
      .admin-access-card{max-width:580px;margin:28px auto;padding:28px;display:grid;grid-template-columns:64px minmax(0,1fr);gap:18px;align-items:start;border-color:rgba(122,49,64,.20);background:linear-gradient(145deg,rgba(255,253,248,.92),rgba(239,228,209,.82))}
      .admin-access-icon{width:62px;height:62px;display:grid;place-items:center;border-radius:18px;background:rgba(122,49,64,.09);color:#743344;border:1px solid rgba(122,49,64,.16)}
      .admin-access-icon .ui-icon{width:28px;height:28px}
      .admin-access-copy h3{margin:5px 0 7px;font-size:32px}
      .admin-access-copy p:not(.eyebrow){margin:0}
      .admin-access-form{grid-column:1/-1;display:grid;gap:10px;margin-top:6px}
      .admin-access-form label{margin:0}
      .admin-password-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}
      .admin-password-row input{height:50px;margin:0;border-radius:14px}
      .admin-password-row button{min-width:120px}
      .admin-access-form .form-message{min-height:0;margin:2px 0 0}
      .admin-access-form .form-message:empty{display:none}
      @media(max-width:540px){
        .admin-access-card{grid-template-columns:50px minmax(0,1fr);padding:20px}
        .admin-access-icon{width:48px;height:48px}
        .admin-access-copy h3{font-size:27px}
        .admin-password-row{grid-template-columns:1fr}
        .admin-password-row button{width:100%}
      }
    </style>`;
  }

  function bindAdminEvents() {

    $$('[data-set-app-mode]').forEach(button => {
      button.addEventListener("click", async () => {
        const mode = button.dataset.setAppMode === "test" ? "test" : "production";
        if (mode === appMode()) return;

        const message = mode === "test"
          ? "¿Cambiar a MODO PRUEBA? Los invitados que abran la app también verán el entorno de prueba hasta volver a Productivo."
          : "¿Volver a PRODUCTIVO? Se mostrarán nuevamente los datos reales.";
        if (!confirm(message)) return;

        button.disabled = true;
        const result = await writeToSheets("saveAppSettings", {
          adminPassword: state.adminPassword,
          settings: {
            ...state.appSettings,
            mode
          }
        }, { allowPreview: true });

        if (!result) {
          button.disabled = false;
          return;
        }

        await syncFromSheets(false);
        toast(mode === "test" ? "Modo prueba activado." : "Modo productivo activado.");
        renderCurrentRoute();
      });
    });

    $$('[data-app-setting]').forEach(input => {
      input.addEventListener("change", async () => {
        const key = input.dataset.appSetting;
        const previous = Boolean(state.appSettings?.[key]);
        const nextSettings = {
          ...state.appSettings,
          [key]: input.checked
        };

        const result = await writeToSheets("saveAppSettings", {
          adminPassword: state.adminPassword,
          settings: nextSettings
        }, { allowPreview: true });

        if (!result) {
          input.checked = previous;
          return;
        }

        applyRemoteAppSettings(nextSettings);
        toast("Configuración global actualizada.");
        renderCurrentRoute();
      });
    });

    $("#startAdminPreview")?.addEventListener("click", () => {
      startAdminGuestPreview($("#adminPreviewGuestSelect")?.value || "");
    });

    $("#downloadFullBackup")?.addEventListener("click", downloadFullBackup);
    $("#restoreBackupInput")?.addEventListener("change", event => {
      const file = event.currentTarget.files?.[0];
      if (file) void restoreBackupFile(file);
    });


    $("#clearSocialMessages")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      const currentMessages = dedupeSocialMessages(state.socialMessages || []);

      if (!currentMessages.length) {
        toast("La sección Social ya está vacía.");
        return;
      }

      if (!confirm("¿Vaciar todos los mensajes y respuestas de Social? Esta acción no se puede deshacer.")) {
        return;
      }

      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Vaciando…";

      const result = await writeToSheets("clearSocialMessages", {
        adminPassword: state.adminPassword,
        timestamp: new Date().toISOString()
      });

      if (!result) {
        button.disabled = false;
        button.textContent = originalText;
        toast("No se pudieron borrar los mensajes.");
        return;
      }

      state.socialMessages = [];
      saveState();

      await syncFromSheets(false);

      state.socialMessages = [];
      saveState();

      toast("Se borraron todos los mensajes y respuestas.");
      renderCurrentRoute();
    });


    $("#adminLoginForm")?.addEventListener("submit", event => {
      event.preventDefault();
      const form = event.currentTarget;
      const password = String(new FormData(form).get("password") || "");
      const message = $("#adminLoginMessage");
      const submitButton = form.querySelector('button[type="submit"]');

      if (password !== CONFIG.LOCAL_ADMIN_PASSWORD) {
        if (message) message.textContent = "Contraseña incorrecta. Volvé a intentarlo.";
        form.elements.password?.select();
        return;
      }

      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Ingresando…";
      }

      state.adminPassword = password;
      state.adminUnlocked = true;
      toast("Centro de mando desbloqueado.");
      renderCurrentRoute();
    });

    const adminModal = $("#adminPeopleModal");
    const closeAdminModal = () => { adminModal?.classList.add("hidden"); document.body.classList.remove("admin-modal-open"); };
    $$('[data-admin-list]').forEach(button => button.addEventListener("click", () => {
      const data = adminGuestListData(button.dataset.adminList);
      const title = $("#adminPeopleTitle"); const count = $("#adminPeopleCount"); const list = $("#adminPeopleList");
      if (title) title.textContent = data.title;
      if (count) count.textContent = `${data.guests.length} ${data.guests.length === 1 ? "persona" : "personas"}`;
      if (list) list.innerHTML = data.guests.length ? data.guests.map(guest => `<div class="admin-person-row"><span>${uiIcon("person")}</span><div><strong>${escapeHTML(guestFullName(guest))}</strong><small>${escapeHTML(data.detail(guest))}</small></div></div>`).join("") : `<div class="admin-empty-list">${uiIcon("checkCircle")}<strong>No hay personas en esta categoría.</strong></div>`;
      adminModal?.classList.remove("hidden"); document.body.classList.add("admin-modal-open");
    }));
    adminModal?.addEventListener("click", event => { if (event.target === adminModal || event.target.closest("[data-admin-modal-close]")) closeAdminModal(); });

    const scoreForm = $("#scoreForm");
    const updateScorePreview = () => {
      if (!scoreForm) return;
      const teamId = scoreForm.querySelector('input[name="teamId"]:checked')?.value || "";
      const sign = Number(scoreForm.querySelector('input[name="scoreSign"]:checked')?.value || 1);
      const amount = Math.abs(Number(scoreForm.elements.points?.value || 0));
      const preview = $("#adminScorePreview");
      const submit = $("#scoreSubmit");
      const teamName = teamId ? getTeam(teamId).name : "";

      if (!teamId || !amount) {
        preview.textContent = teamId ? `${teamName} · falta cantidad` : "Seleccioná un equipo";
        submit.textContent = "Seleccioná un equipo y una cantidad";
        submit.disabled = true;
        submit.classList.toggle("is-negative", sign < 0);
        return;
      }

      const verb = sign < 0 ? "Restar" : "Sumar";
      preview.textContent = `${verb} ${amount} a ${teamName}`;
      submit.textContent = `${verb} ${amount} puntos a ${teamName}`;
      submit.disabled = false;
      submit.classList.toggle("is-negative", sign < 0);
    };

    $$("[data-score-preset]").forEach(button => button.addEventListener("click", () => {
      if (!scoreForm) return;
      scoreForm.elements.points.value = button.dataset.scorePreset;
      updateScorePreview();
    }));

    scoreForm?.querySelectorAll('input[name="teamId"], input[name="scoreSign"], input[name="points"]').forEach(input => {
      input.addEventListener("input", updateScorePreview);
      input.addEventListener("change", updateScorePreview);
    });
    updateScorePreview();

    scoreForm?.addEventListener("submit", async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const sign = Number(values.scoreSign || 1);
      const amount = Math.abs(Number(values.points || 0));
      const teamId = values.teamId;

      if (!teamId || !amount) {
        toast("Elegí un equipo y una cantidad válida.");
        return;
      }

      if (sign < 0 && !confirm(`¿Restar ${amount} puntos al equipo ${getTeam(teamId).name}?`)) return;

      const { scoreSign, ...cleanValues } = values;
      const payload = {
        ...cleanValues,
        points: amount * sign,
        adminPassword: state.adminPassword,
        adminName: "Fede y Vani",
        timestamp: new Date().toISOString()
      };

      const submitButton = $("#scoreSubmit");
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Guardando movimiento…";
      }
      payload.requestId = newRequestId("saveScore");

      const result = await writeToSheets("saveScore", payload);
      if (!result) {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "Volver a intentar";
        }
        toast("El movimiento no quedó guardado.");
        return;
      }

      const savedRecord = result.record || payload;
      state.scoreEntries.push(savedRecord);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      scheduleSilentSync();

      toast(`${sign < 0 ? "Se restaron" : "Se sumaron"} ${amount} puntos a ${getTeam(teamId).name}.`);
      renderCurrentRoute();
    });

    $("#resetTestData")?.addEventListener("click", async () => {
      if (!isTestMode()) {
        toast("Cambiá a Modo prueba antes de resetear datos de prueba.");
        return;
      }
      const firstConfirmation = confirm(
        "¿Resetear los datos de prueba?\n\nSe limpiarán:\n• Confirmaciones RSVP\n• Formularios personales\n• Respuestas de juegos\n\nLos invitados y los puntos discrecionales no se borrarán."
      );
      if (!firstConfirmation) return;

      const confirmationWord = prompt('Para confirmar, escribí RESET');
      if (normalize(confirmationWord) !== "reset") {
        toast("Reset cancelado.");
        return;
      }

      const button = $("#resetTestData");
      const originalText = button?.textContent || "Resetear RSVP y formularios";
      if (button) {
        button.disabled = true;
        button.textContent = "Reseteando…";
      }

      const timestamp = new Date().toISOString();
      const markerPayload = {
        guestId: "__vf_reset_test_data__",
        teamId: "admin",
        resetMarker: true,
        resetScope: "test-data",
        updatedAt: timestamp,
        adminPassword: state.adminPassword,
        comment: "Reset general de datos de prueba desde Admin"
      };

      const savedRemotely = await postToSheets("saveRsvp", markerPayload);

      if (!savedRemotely) {
        if (button) {
          button.disabled = false;
          button.textContent = originalText;
        }
        toast("No se pudo guardar el reset. No se borró nada.");
        return;
      }

      state.dataResetAt = timestamp;
      state.rsvps = {};
      state.profiles = {};
      state.gameSubmissions = {};
      state.rsvpEditMode = false;
      state.profileEditMode = false;
      saveState();

      scheduleSilentSync();
      toast("Datos de prueba reseteados. Los testers ya pueden completar todo nuevamente.");
      renderCurrentRoute();
    });

    $("#resetDiscretionaryPoints")?.addEventListener("click", async () => {
      if (!confirm("¿Resetear solo los puntos discrecionales cargados por Fede y Vani? También se limpiarán esos movimientos de la vista pública. RSVP y datos de invitados no se modifican.")) return;
      const timestamp = new Date().toISOString();
      const hasDiscretionary = allPointEntries().some(entry => entry.gameId === "discrecional-fede-vani");
      if (!hasDiscretionary) { toast("No hay puntos discrecionales para resetear."); return; }
      const payload = {
        gameId: "reset-discretionary-clear-marker",
        teamId: "admin",
        points: 0,
        comment: "Limpieza de puntos discrecionales por Fede y Vani",
        adminPassword: state.adminPassword,
        adminName: "Fede y Vani",
        timestamp
      };
      state.scoreEntries.push(payload);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      toast("Puntos discrecionales y movimientos anteriores limpiados.");
      await postToSheets("saveScore", payload);
      scheduleSilentSync();
      renderCurrentRoute();
    });

    $("#resetAllPoints")?.addEventListener("click", async () => {
      if (!confirm("¿Resetear TODOS los puntos actuales del ranking? También se limpiarán los movimientos anteriores de la vista pública. No borra RSVP ni datos de invitados.")) return;
      const timestamp = new Date().toISOString();
      if (!allPointEntries().length) { toast("El ranking ya está en cero."); return; }
      const payload = {
        gameId: "reset-total-clear-marker",
        teamId: "admin",
        points: 0,
        comment: "Limpieza general de puntos por Fede y Vani",
        adminPassword: state.adminPassword,
        adminName: "Fede y Vani",
        timestamp
      };
      state.scoreEntries.push(payload);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      toast("Todos los puntos y movimientos anteriores fueron limpiados.");
      await postToSheets("saveScore", payload);
      scheduleSilentSync();
      renderCurrentRoute();
    });

    $$("[data-unlock-key]").forEach(input => input.addEventListener("change", async event => {
      const control = event.currentTarget;
      const key = control.dataset.unlockKey;
      const open = control.checked;

      initializeCurrentNotifications();
      control.disabled = true;

      const saved = await writeToSheets("saveUnlock", {
        key,
        open,
        adminPassword: state.adminPassword,
        timestamp: new Date().toISOString()
      });

      if (!saved) {
        control.checked = !open;
        control.disabled = false;
        toast("No se pudo guardar el cambio.");
        return;
      }

      const serverUnlockState =
        saved.details?.unlockState ||
        saved.response?.data?.details?.unlockState ||
        null;

      if (serverUnlockState) {
        applyRemoteUnlockSnapshot(
          {
            manualUnlocks: serverUnlockState.manualUnlocks,
            unlockRevision: serverUnlockState.revision,
            generatedAt: serverUnlockState.generatedAt
          },
          {
            render: false
          }
        );
      } else {
        // Compatibilidad durante el despliegue.
        state.manualUnlocks = {
          ...state.manualUnlocks,
          [key]: open
        };
        saveState();
        await syncFromSheets(false);
      }

      updateSectionNavigationState();
      updateNotificationUi();

      const sectionName = sectionLabelForKey(key);
      const isSectionKey = SECTION_DEFINITIONS.some(
        item => item.key === key
      );
      const featureMessage = isSectionKey
        ? `${sectionName} ${open ? "habilitada" : "oculta"}.`
        : (open ? "Juego habilitado." : "Juego oculto.");

      toast(featureMessage);
      renderCurrentRoute();
    }));

    $("#setupSheets")?.addEventListener("click", async () => {
      if (!isConfigured()) { toast("Falta configurar la conexión remota."); return; }
      try {
        await jsonp("setup", { adminPassword: state.adminPassword });
        toast("Base inicializada.");
        syncFromSheets(true);
      } catch (error) {
        toast(`No se pudo inicializar: ${error.message}`);
      }
    });

    $("#exportOfficialGuests")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `${uiIcon("sync")}<span>Actualizando datos…</span>`;

      await syncFromSheets(false);

      const confirmed = DATA.guests.filter(guest => {
        const rsvp = state.rsvps[guest.id];
        return isCompetitionGuest(guest) && hasCompletedRsvp(rsvp) && rsvp.attendance === "si";
      }).length;

      if (!confirmed) {
        toast("Todavía no hay personas confirmadas para exportar.");
        button.disabled = false;
        button.innerHTML = original;
        return;
      }

      const date = new Date().toISOString().slice(0, 10);
      downloadFile(
        `lista-oficial-casamiento-vani-fede-${date}.csv`,
        buildOfficialGuestCsv(),
        "text/csv;charset=utf-8"
      );
      toast(`Lista oficial exportada: ${confirmed} personas confirmadas.`);
    });

    $("#lockAdminButton")?.addEventListener("click", () => {
      state.adminUnlocked = false;
      state.adminPassword = "";
      toast("Administración bloqueada.");
      renderCurrentRoute();
    });

    $("#syncNow")?.addEventListener("click", () => syncFromSheets(true));
    $("#exportJson")?.addEventListener("click", () => downloadFile("convocatoria-vani-fede-datos.json", JSON.stringify(state, null, 2), "application/json"));
    $("#exportCsv")?.addEventListener("click", () => downloadFile("rsvp-vani-fede.csv", buildRsvpCsv(), "text/csv;charset=utf-8"));
    $("#resetLocal")?.addEventListener("click", () => {
      if (!confirm("¿Borrar todos los datos locales de este navegador? Los datos compartidos no se borran.")) return;
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    });
  }

  function buildOfficialGuestCsv() {
    const header = [
      "Nombre",
      "Apellido",
      "Nombre completo",
      "Equipo",
      "Relación",
      "Email",
      "Teléfono",
      "Asistencia",
      "Traslado / micro",
      "Restricciones alimenticias",
      "Canción que quiere escuchar",
      "Canción que no quiere escuchar",
      "Comida preferida",
      "Postre preferido",
      "Canción propuesta para la boda",
      "Canción propuesta para entrada del equipo",
      "Última actualización"
    ];

    const rows = DATA.guests
      .filter(guest => {
        const rsvp = state.rsvps[guest.id];
        return isCompetitionGuest(guest) && hasCompletedRsvp(rsvp) && rsvp.attendance === "si";
      })
      .sort((a, b) => `${a.lastName || ""} ${a.firstName || ""}`.localeCompare(
        `${b.lastName || ""} ${b.firstName || ""}`,
        "es"
      ))
      .map(guest => {
        const rsvp = state.rsvps[guest.id] || {};
        const profile = state.profiles[guest.id] || {};
        const music = state.gameSubmissions[`${guest.id}::music-selection`] || {};

        return [
          guest.firstName || rsvp.firstName || "",
          guest.lastName || rsvp.lastName || "",
          `${guest.firstName || rsvp.firstName || ""} ${guest.lastName || rsvp.lastName || ""}`.trim(),
          getTeam(guest.team).name,
          guest.roleVisible || guest.displayRelation || guest.relation || "",
          rsvp.email || guest.email || "",
          rsvp.phone || "",
          attendanceLabel(rsvp.attendance),
          transportLabel(rsvp.transport),
          rsvp.diet || "",
          profile.songYes || "",
          profile.songNo || "",
          profile.favoriteFood || "",
          profile.favoriteDessert || "",
          music.weddingSong || "",
          music.teamEntranceSong || "",
          rsvp.updatedAt || ""
        ];
      });

    const separator = ";";
    const csv = [header, ...rows]
      .map(row => row.map(csvCell).join(separator))
      .join("\r\n");

    return "\uFEFF" + csv;
  }

  function buildRsvpCsv() {
    const header = ["guestId", "nombre", "apellido", "email", "telefono", "asistencia", "traslado", "restricciones", "updatedAt"];
    const rows = Object.entries(state.rsvps).map(([guestId, row]) => [guestId, row.firstName, row.lastName, row.email, row.phone, row.attendance, row.transport, row.diet, row.updatedAt]);
    return [header, ...rows].map(row => row.map(csvCell).join(",")).join("\n");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  boot();
})();
