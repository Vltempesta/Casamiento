(() => {
  const DATA = window.WEDDING_APP_DATA;
  const CONFIG = window.WEDDING_APP_CONFIG || {};
  const STORAGE_KEY = "vf_convocatoria_real_v2";
  const ONLINE_COPY = {
    idle: "Sheets sin configurar",
    connecting: "Conectando Sheets",
    online: "Sheets conectado",
    local: "Modo local",
    error: "Sheets no responde"
  };

  let currentGuest = null;
  let currentRoute = "inicio";
  let remoteStatus = "idle";

  const defaultState = {
    currentGuestId: null,
    adminUnlocked: false,
    adminPassword: "",
    rsvps: {},
    profiles: {},
    gameSubmissions: {},
    scoreEntries: [],
    manualUnlocks: {},
    lastSyncAt: null,
    lastRemoteError: ""
  };

  let state = loadState();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function loadState() {
    try {
      return { ...defaultState, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")) };
    } catch (error) {
      console.warn("No se pudo leer el estado local", error);
      return { ...defaultState };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

  function findGuest(query) {
    const wanted = normalize(query);
    if (!wanted) return null;
    return DATA.guests.find(guest => {
      const haystack = normalize([
        guest.id,
        guest.firstName,
        guest.lastName,
        `${guest.firstName} ${guest.lastName}`,
        guest.alias,
        guest.email,
        guest.relation,
        getTeam(guest.team).name
      ].join(" "));
      return haystack === wanted || haystack.includes(wanted) || wanted.includes(haystack);
    });
  }

  function isConfigured() {
    return Boolean(CONFIG.ENABLE_REMOTE_SYNC && CONFIG.GOOGLE_APPS_SCRIPT_URL && CONFIG.GOOGLE_APPS_SCRIPT_URL.startsWith("http"));
  }

  function setRemoteStatus(status, message = "") {
    remoteStatus = status;
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
        reject(new Error("Google Apps Script URL no configurada"));
        return;
      }

      const callbackName = `__vfSheets_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const url = new URL(CONFIG.GOOGLE_APPS_SCRIPT_URL);
      url.searchParams.set("action", action);
      url.searchParams.set("callback", callbackName);
      url.searchParams.set("token", CONFIG.PUBLIC_WRITE_TOKEN || "");
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value ?? ""));

      const script = document.createElement("script");
      const timeout = window.setTimeout(() => cleanup(() => reject(new Error("Timeout conectando con Google Sheets"))), 12000);

      function cleanup(done) {
        window.clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
        done?.();
      }

      window[callbackName] = payload => {
        cleanup(() => {
          if (payload && payload.ok !== false) resolve(payload);
          else reject(new Error(payload?.error || "Respuesta inválida de Google Sheets"));
        });
      };

      script.onerror = () => cleanup(() => reject(new Error("No se pudo cargar la respuesta de Google Sheets")));
      script.src = url.toString();
      document.body.appendChild(script);
    });
  }

  async function postToSheets(action, payload) {
    if (!isConfigured()) return false;
    const envelope = {
      action,
      token: CONFIG.PUBLIC_WRITE_TOKEN || "",
      appVersion: DATA.appVersion,
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      submittedAt: new Date().toISOString(),
      ...payload
    };
    try {
      await fetch(CONFIG.GOOGLE_APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        cache: "no-store",
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(envelope)
      });
      return true;
    } catch (error) {
      console.warn("Fallo escritura Sheets", error);
      state.lastRemoteError = error.message;
      saveState();
      return false;
    }
  }

  function mergeRemoteData(remote = {}) {
    if (remote.rsvps && typeof remote.rsvps === "object") state.rsvps = { ...state.rsvps, ...remote.rsvps };
    if (remote.profiles && typeof remote.profiles === "object") state.profiles = { ...state.profiles, ...remote.profiles };
    if (remote.gameSubmissions && typeof remote.gameSubmissions === "object") state.gameSubmissions = { ...state.gameSubmissions, ...remote.gameSubmissions };
    if (Array.isArray(remote.scoreEntries)) state.scoreEntries = dedupeScores([...state.scoreEntries, ...remote.scoreEntries]);
    if (remote.manualUnlocks && typeof remote.manualUnlocks === "object") state.manualUnlocks = { ...state.manualUnlocks, ...remote.manualUnlocks };
    state.lastSyncAt = new Date().toISOString();
    state.lastRemoteError = "";
    saveState();
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
      if (showToast) toast("Pegá la URL de Apps Script en config.js para activar Google Sheets.");
      return false;
    }
    setRemoteStatus("connecting");
    try {
      const payload = await jsonp("getData");
      mergeRemoteData(payload.data || {});
      setRemoteStatus("online", `Sheets conectado${state.lastSyncAt ? " · " + new Date(state.lastSyncAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : ""}`);
      if (showToast) toast("Datos sincronizados con Google Sheets.");
      if (currentGuest) renderCurrentRoute();
      return true;
    } catch (error) {
      state.lastRemoteError = error.message;
      saveState();
      setRemoteStatus("error");
      if (showToast) toast("No se pudo leer Google Sheets. La app sigue guardando localmente.");
      return false;
    }
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

  function boot() {
    setRemoteStatus(isConfigured() ? "connecting" : "idle");
    fillGuestSuggestions();
    bindShellEvents();
    if (state.currentGuestId) {
      const guest = getGuestById(state.currentGuestId);
      if (guest) enterApp(guest, false);
    }
    syncFromSheets(false);
  }

  function fillGuestSuggestions() {
    const datalist = $("#guestSuggestions");
    datalist.innerHTML = DATA.guests.map(guest => `<option value="${escapeHTML(`${guest.firstName} ${guest.lastName}`.trim())}"></option>`).join("");
  }

  function bindShellEvents() {
    $("#loginForm").addEventListener("submit", event => {
      event.preventDefault();
      const guest = findGuest($("#guestName").value);
      const message = $("#loginMessage");
      if (!guest) {
        message.textContent = "No encontré ese nombre. Probá con nombre completo, alias o revisá que esté en data.js.";
        return;
      }
      message.textContent = "";
      enterApp(guest, true);
      postToSheets("logEvent", { eventName: "login", guestId: guest.id, teamId: guest.team });
    });

    $("#logoutButton").addEventListener("click", () => {
      currentGuest = null;
      state.currentGuestId = null;
      saveState();
      $("#mainScreen").classList.add("hidden");
      $("#loginScreen").classList.remove("hidden");
      $("#guestName").focus();
    });

    $("#shareButton").addEventListener("click", async () => {
      const text = DATA.couple.whatsappDescription;
      try {
        if (navigator.share) await navigator.share({ title: DATA.couple.title, text, url: location.href });
        else {
          await navigator.clipboard.writeText(`${text} ${location.href}`);
          toast("Link copiado para compartir.");
        }
      } catch (_) {
        toast("No se pudo compartir desde este navegador.");
      }
    });

    $("#syncButton").addEventListener("click", () => syncFromSheets(true));

    $$(".nav-tabs button").forEach(button => {
      button.addEventListener("click", () => navigate(button.dataset.route));
    });
  }

  function enterApp(guest, showWelcome) {
    currentGuest = guest;
    state.currentGuestId = guest.id;
    saveState();
    const team = getTeam(guest.team);
    document.documentElement.style.setProperty("--team-accent", team.accent || "#c8a75d");
    $("#loginScreen").classList.add("hidden");
    $("#mainScreen").classList.remove("hidden");
    $("#welcomeTitle").textContent = `Hola, ${guest.firstName}.`;
    $("#welcomeSub").textContent = `Tu fuerza es ${team.name}. Capitán: ${team.captain}.`;
    navigate(currentRoute || "inicio");
    if (showWelcome) toast(`Acceso concedido · ${team.emoji} Equipo ${team.name}.`);
  }

  function navigate(route) {
    currentRoute = route;
    $$(".nav-tabs button").forEach(button => button.classList.toggle("active", button.dataset.route === route));
    renderCurrentRoute();
  }

  function renderCurrentRoute() {
    const routes = {
      inicio: renderHome,
      info: renderInfo,
      asistencia: renderRSVP,
      ficha: renderProfile,
      equipo: renderTeam,
      torneo: renderTournament,
      juegos: renderGames,
      ranking: renderRanking,
      invitados: renderGuests,
      admin: renderAdmin
    };
    const html = (routes[currentRoute] || renderHome)();
    $("#view").innerHTML = html;
    bindViewEvents(currentRoute);
  }

  function sectionHeader(kicker, title, text) {
    return `
      <div class="section-head">
        <p class="eyebrow">${escapeHTML(kicker)}</p>
        <h3>${escapeHTML(title)}</h3>
        <p>${escapeHTML(text)}</p>
      </div>`;
  }

  function actionCard(route, title, detail, icon, done = false) {
    return `
      <button class="action-card ${done ? "done" : ""}" type="button" data-go="${route}">
        <span>${icon}</span>
        <strong>${escapeHTML(title)}</strong>
        <small>${escapeHTML(detail)}</small>
      </button>`;
  }

  function renderHome() {
    const team = getTeam(currentGuest.team);
    const rsvp = state.rsvps[currentGuest.id];
    const profile = state.profiles[currentGuest.id];
    const submittedGames = Object.keys(state.gameSubmissions || {}).filter(key => key.startsWith(`${currentGuest.id}::`)).length;
    const rank = calculateRanking();
    const myRank = rank.findIndex(row => row.id === team.id) + 1;
    return `
      <section class="hero-card" style="--local-accent:${team.accent}">
        <div class="hero-copy">
          <p class="eyebrow">Archivo personal</p>
          <h3>Tu destino fue revelado.</h3>
          <p>Has sido convocado por la fuerza de <strong>${team.name}</strong>. Desde este panel confirmás asistencia, completás tu ficha secreta, participás del torneo previo y llegás listo a la verdadera batalla.</p>
          <div class="badge-row">
            <span class="badge">${team.emoji} Equipo ${team.name}</span>
            <span class="badge muted">Capitán: ${escapeHTML(team.captain)}</span>
            <span class="badge muted">${escapeHTML(DATA.couple.dateLabel)}</span>
          </div>
        </div>
        <div class="team-medallion">
          <span class="emoji">${team.emoji}</span>
          <strong>${team.name}</strong>
          <small>${escapeHTML(team.motto)}</small>
          <div class="score-chip">Puesto actual: ${myRank || "—"}</div>
        </div>
      </section>

      <section class="stats-grid">
        ${statCard("Asistencia", rsvp ? "Registrada" : "Pendiente", rsvp ? "✅" : "✉️")}
        ${statCard("Ficha secreta", profile ? "Cargada" : "Pendiente", profile ? "✅" : "🕯️")}
        ${statCard("Juegos enviados", String(submittedGames), "🎲")}
        ${statCard("Puntos del equipo", String(rank.find(r => r.id === team.id)?.total || 0), "🏆")}
      </section>

      ${sectionHeader("próximos pasos", "Lo importante primero", "Completá los datos básicos. El resto se va abriendo por fecha, por equipo o por decisión de los novios.")}
      <section class="grid four">
        ${actionCard("asistencia", rsvp ? "Asistencia confirmada" : "Confirmar asistencia", rsvp ? "Podés editarla cuando quieras." : "Nombre, mail, comida y restricciones.", rsvp ? "✅" : "✉️", Boolean(rsvp))}
        ${actionCard("ficha", profile ? "Ficha cargada" : "Completar ficha secreta", profile ? "Tus respuestas ya alimentan los juegos." : "Canciones, secretos, gustos y desafíos.", profile ? "✅" : "🕯️", Boolean(profile))}
        ${actionCard("equipo", `Ver ${team.name}`, "Integrantes, capitán, lema y estrategia.", team.emoji)}
        ${actionCard("ranking", "Ranking general", "Puntos previos, físicos, bonus y penalizaciones.", "🏆")}
      </section>

      ${sectionHeader("candados", "Estado de archivos", "La página puede ir revelando información sin volver a mandar otro link.")}
      <section class="grid three">${Object.keys(DATA.unlocks).map(unlockCard).join("")}</section>
    `;
  }

  function statCard(label, value, icon) {
    return `<article class="stat-card"><span>${icon}</span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></article>`;
  }

  function renderInfo() {
    const locationOpen = isUnlocked("location");
    const menuOpen = isUnlocked("menu");
    return `
      ${sectionHeader("info terrenal", "Todo lo que sí o sí tienen que saber", "Horario, código de vestimenta, punto de encuentro, cronograma y menú con desbloqueos progresivos.")}
      <section class="grid two">
        <article class="section-card major">
          <span class="card-icon">📜</span>
          <h4>Día y horario</h4>
          <p><strong>Sábado 24 de octubre de 2026</strong></p>
          <p>Fiesta de ${escapeHTML(DATA.couple.partyTime)} · Ceremonia ${escapeHTML(DATA.couple.ceremonyTime)}</p>
          <p>${escapeHTML(DATA.info.arrivalRecommendation)}</p>
        </article>
        <article class="section-card major ${locationOpen ? "" : "locked-panel"}">
          <span class="card-icon">${locationOpen ? "📍" : "🔒"}</span>
          <h4>${locationOpen ? DATA.couple.placeName : DATA.couple.placeSecretLabel}</h4>
          <p>${locationOpen ? `${DATA.couple.placeArea}. Dirección exacta y mapa listos para compartir.` : DATA.unlocks.location.teaser}</p>
          <small>${locationOpen ? "Archivo abierto" : `Se libera: ${formatDateLabel(DATA.unlocks.location.unlockAt)}`}</small>
        </article>
      </section>

      <section class="grid three">
        <article class="section-card"><span class="card-icon">🖤</span><h4>Código de vestimenta</h4><p>${escapeHTML(DATA.info.dressCode)}</p></article>
        <article class="section-card"><span class="card-icon">🚐</span><h4>Punto de encuentro</h4><p>${escapeHTML(DATA.info.meetingPoint)}</p></article>
        <article class="section-card"><span class="card-icon">☎️</span><h4>Contacto emergencia</h4><p>${escapeHTML(DATA.info.emergencyContact)}</p></article>
      </section>

      <section class="section-card">
        <div class="card-title-row"><h4>Cronograma</h4><span class="badge muted">sujeto a hechizos de último momento</span></div>
        <div class="timeline">${DATA.info.timeline.map(item => `
          <div class="timeline-item">
            <time>${escapeHTML(item.time)}</time>
            <div><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.detail)}</p></div>
          </div>`).join("")}</div>
      </section>

      <section class="section-card ${menuOpen ? "" : "locked-panel"}">
        <div class="card-title-row"><h4>Menú de la noche</h4><span class="badge">${menuOpen ? "Disponible" : "Bloqueado"}</span></div>
        ${menuOpen ? `
          <div class="grid two compact">
            ${Object.entries(DATA.info.menu).map(([key, value]) => `<div class="menu-line"><strong>${menuLabel(key)}</strong><p>${escapeHTML(value)}</p></div>`).join("")}
          </div>` : `<p>${escapeHTML(DATA.unlocks.menu.teaser)}</p><small>Se libera: ${formatDateLabel(DATA.unlocks.menu.unlockAt)}</small>`}
      </section>`;
  }

  function menuLabel(key) {
    return ({ reception: "Recepción", main: "Principal", veggie: "Especiales", dessert: "Postre", lateNight: "Trasnoche" })[key] || key;
  }

  function renderRSVP() {
    const saved = state.rsvps[currentGuest.id] || {};
    return `
      ${sectionHeader("confirmación", "Confirmar asistencia", `Fecha sugerida para responder: ${CONFIG.RSVP_DEADLINE_LABEL || "a definir"}. Tus datos se guardan en Google Sheets cuando la conexión está activa.`)}
      <form id="rsvpForm" class="section-card form-card">
        <div class="form-grid">
          ${field("firstName", "Nombre", saved.firstName || currentGuest.firstName, "text", true)}
          ${field("lastName", "Apellido", saved.lastName || currentGuest.lastName, "text", true)}
          ${field("email", "Mail", saved.email || currentGuest.email || "", "email", true)}
          ${field("phone", "Teléfono", saved.phone || "", "tel", false)}
          <label>Confirmo asistencia
            <select name="attendance" required>
              ${option("", "Seleccionar", saved.attendance)}
              ${option("si", "Sí, voy", saved.attendance)}
              ${option("no", "No puedo asistir", saved.attendance)}
              ${option("a-confirmar", "A confirmar", saved.attendance)}
            </select>
          </label>
          <label>Traslado / combi
            <select name="transport">
              ${option("", "A definir", saved.transport)}
              ${option("auto", "Voy en auto", saved.transport)}
              ${option("combi", "Necesito info de combi", saved.transport)}
              ${option("duermo", "Duermo en la estancia", saved.transport)}
            </select>
          </label>
        </div>
        <label>Restricciones alimentarias / alergias
          <textarea name="diet" placeholder="Ej: vegetariano, celíaco, sin lactosa, alergia a frutos secos...">${escapeHTML(saved.diet || "")}</textarea>
        </label>
        <label>Comentario para los novios
          <textarea name="comment" placeholder="Algo que necesitemos saber...">${escapeHTML(saved.comment || "")}</textarea>
        </label>
        <div class="form-actions">
          <button type="submit">Guardar asistencia</button>
          <span class="form-note">${saved.updatedAt ? `Última edición: ${formatDateLabel(saved.updatedAt)}` : "Todavía no registrado."}</span>
        </div>
      </form>`;
  }

  function field(name, label, value = "", type = "text", required = false) {
    return `<label>${escapeHTML(label)}<input name="${name}" type="${type}" value="${escapeHTML(value)}" ${required ? "required" : ""}></label>`;
  }

  function option(value, label, selected) {
    return `<option value="${escapeHTML(value)}" ${value === selected ? "selected" : ""}>${escapeHTML(label)}</option>`;
  }

  function renderProfile() {
    const saved = state.profiles[currentGuest.id] || {};
    return `
      ${sectionHeader("ficha secreta", "Material clasificado para juegos", "Estas respuestas pueden convertirse en trivia, bingo, desafíos, playlist, premios o confesiones anónimas.")}
      <form id="profileForm" class="section-card form-card">
        <div class="warning-ribbon">Tus respuestas podrán ser usadas en tu contra durante la noche.</div>
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
        <div class="form-actions"><button type="submit">Guardar ficha secreta</button><span class="form-note">${saved.updatedAt ? `Última edición: ${formatDateLabel(saved.updatedAt)}` : "Pendiente de carga."}</span></div>
      </form>`;
  }

  function renderTeam() {
    const team = getTeam(currentGuest.team);
    const members = DATA.guests.filter(guest => guest.team === team.id);
    return `
      ${sectionHeader("mi fuerza", `Equipo ${team.name}`, `${team.group}. Capitán: ${team.captain}.`)}
      <section class="team-hero section-card" style="--local-accent:${team.accent}">
        <div class="team-symbol">${team.emoji}</div>
        <div><h3>${team.name}</h3><p>${escapeHTML(team.motto)}</p><div class="badge-row"><span class="badge">${escapeHTML(team.colorName)}</span><span class="badge muted">${escapeHTML(team.trait)}</span></div></div>
      </section>
      <section class="grid two">
        <article class="section-card"><h4>Formación</h4><div class="guest-list">${members.map(guestPill).join("")}</div></article>
        <article class="section-card"><h4>Estrategia</h4><p>${escapeHTML(team.strategy)}</p><hr><p><strong>Rol del capitán:</strong> activar al equipo, responder consignas, decidir comodines y cargar mística.</p></article>
      </section>`;
  }

  function guestPill(guest) {
    const team = getTeam(guest.team);
    return `<div class="guest-pill"><span>${team.emoji}</span><div><strong>${escapeHTML(`${guest.firstName} ${guest.lastName}`.trim())}</strong><small>${escapeHTML(guest.alias)} · ${escapeHTML(guest.role)}</small></div></div>`;
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
      ${sectionHeader("juegos", "Desafíos digitales y batalla física", "Los juegos se pueden habilitar antes o durante la fiesta. Las respuestas digitales quedan en Google Sheets y los puntos físicos se cargan desde Admin.")}
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

  function renderRanking() {
    const ranking = calculateRanking();
    return `
      ${sectionHeader("ranking", "La tabla de fuerzas", "Suma desafíos digitales, juegos físicos, bonus y penalizaciones cargadas desde el panel admin.")}
      <section class="ranking-list">${ranking.map(rankRow).join("")}</section>
      <section class="section-card"><h4>Últimos movimientos</h4>${state.scoreEntries.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Juego</th><th>Equipo</th><th>Puntos</th><th>Comentario</th></tr></thead><tbody>${state.scoreEntries.slice(-12).reverse().map(entry => `<tr><td>${formatDateLabel(entry.timestamp || entry.submittedAt || entry.updatedAt)}</td><td>${escapeHTML(gameName(entry.gameId))}</td><td>${escapeHTML(getTeam(entry.teamId).name)}</td><td>${Number(entry.points || 0)}</td><td>${escapeHTML(entry.comment || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p>Todavía no hay puntos cargados.</p>`}</section>`;
  }

  function rankRow(row, index) {
    const team = getTeam(row.id);
    const pos = index + 1;
    return `<article class="rank-item" style="--local-accent:${team.accent}"><span class="rank-pos">${pos}</span><span class="rank-emoji">${team.emoji}</span><div><strong>${team.name}</strong><small>${team.group}</small></div><div class="rank-points"><strong>${row.total}</strong><small>puntos</small></div></article>`;
  }

  function calculateRanking() {
    const totals = Object.keys(DATA.teams).map(id => ({ id, total: 0 }));
    for (const entry of state.scoreEntries || []) {
      const row = totals.find(item => item.id === entry.teamId);
      if (row) row.total += Number(entry.points || 0);
    }
    return totals.sort((a, b) => b.total - a.total || DATA.teams[a.id].name.localeCompare(DATA.teams[b.id].name));
  }

  function gameName(id) {
    return DATA.games.find(game => game.id === id)?.title || id || "Juego";
  }

  function renderGuests() {
    const open = isUnlocked("guestMap");
    const grouped = Object.values(DATA.teams).map(team => ({ team, guests: DATA.guests.filter(guest => guest.team === team.id) }));
    return `
      ${sectionHeader("organigrama", "Mapa de invitados", "Un quién-es-quién de la noche, con alias, equipos y personajes clave.")}
      ${open ? "" : lockedNotice("guestMap")}
      <section class="guest-map">${grouped.map(group => `
        <article class="section-card team-column" style="--local-accent:${group.team.accent}">
          <h4>${group.team.emoji} ${group.team.name}</h4>
          <small>${escapeHTML(group.team.group)}</small>
          <div class="guest-list">${group.guests.map(guestPill).join("")}</div>
        </article>`).join("")}</section>`;
  }

  function renderAdmin() {
    if (!state.adminUnlocked) {
      return `
        ${sectionHeader("admin", "Panel de control", "Carga puntos, abre candados, inicializa Google Sheets y exporta la información.")}
        <form id="adminLoginForm" class="section-card form-card narrow">
          <label>Clave admin<input name="password" type="password" placeholder="Clave"></label>
          <button type="submit">Entrar al panel</button>
          <p class="form-note">La clave real para escribir puntos se valida también en Apps Script.</p>
        </form>`;
    }
    const rsvpCount = Object.keys(state.rsvps).length;
    const profileCount = Object.keys(state.profiles).length;
    return `
      ${sectionHeader("admin", "Centro de mando", "Panel simple para operar la app desde el navegador durante la previa y la fiesta.")}
      <section class="stats-grid">
        ${statCard("RSVP", String(rsvpCount), "✉️")}
        ${statCard("Fichas", String(profileCount), "🕯️")}
        ${statCard("Puntajes", String(state.scoreEntries.length), "🏆")}
        ${statCard("Sheets", isConfigured() ? "Activo" : "Pendiente", isConfigured() ? "✅" : "⚠️")}
      </section>
      <section class="grid two">
        <form id="scoreForm" class="section-card form-card">
          <h4>Cargar puntos</h4>
          <label>Juego<select name="gameId" required>${DATA.games.map(game => option(game.id, game.title, "")).join("")}</select></label>
          <label>Equipo<select name="teamId" required>${Object.values(DATA.teams).map(team => option(team.id, `${team.emoji} ${team.name}`, "")).join("")}</select></label>
          <label>Puntos<input name="points" type="number" step="1" placeholder="Ej: 50 o -10" required></label>
          <label>Comentario<textarea name="comment" placeholder="Ej: ganó kermesse, bonus capitán, penalización..."></textarea></label>
          <button type="submit">Guardar puntos</button>
        </form>
        <article class="section-card">
          <h4>Candados</h4>
          <div class="unlock-list">${Object.entries(DATA.unlocks).map(([key, unlock]) => `<label class="toggle-row"><span><strong>${escapeHTML(unlock.title)}</strong><small>${escapeHTML(unlock.teaser)}</small></span><input type="checkbox" data-unlock-key="${key}" ${isUnlocked(key) ? "checked" : ""}></label>`).join("")}</div>
        </article>
      </section>
      <section class="section-card">
        <h4>Google Sheets y exportación</h4>
        <div class="button-row">
          <button id="setupSheets" type="button">Inicializar hojas</button>
          <button id="syncNow" type="button">Leer Sheets</button>
          <button id="exportJson" type="button" class="ghost-button">Exportar JSON local</button>
          <button id="exportCsv" type="button" class="ghost-button">Exportar RSVP CSV</button>
          <button id="resetLocal" type="button" class="danger-button">Borrar datos locales</button>
        </div>
        <p class="form-note">${isConfigured() ? "La URL de Apps Script está cargada en config.js." : "Falta pegar la URL del Web App en config.js."}</p>
      </section>`;
  }

  function bindViewEvents(route) {
    $$('[data-go]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.go)));

    if (route === "asistencia") {
      $("#rsvpForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = { ...values, guestId: currentGuest.id, teamId: currentGuest.team, updatedAt: new Date().toISOString() };
        state.rsvps[currentGuest.id] = payload;
        saveState();
        renderCurrentRoute();
        toast("Asistencia guardada. El bosque tomó nota.");
        postToSheets("saveRsvp", payload);
      });
    }

    if (route === "ficha") {
      $("#profileForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = { ...values, guestId: currentGuest.id, teamId: currentGuest.team, updatedAt: new Date().toISOString() };
        state.profiles[currentGuest.id] = payload;
        saveState();
        renderCurrentRoute();
        toast("Ficha secreta guardada.");
        postToSheets("saveProfile", payload);
      });
    }

    if (route === "juegos" || route === "torneo") {
      $$(".game-submit").forEach(form => form.addEventListener("submit", event => {
        event.preventDefault();
        const gameId = event.currentTarget.dataset.gameId;
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const key = `${currentGuest.id}::${gameId}`;
        const payload = { ...values, gameId, guestId: currentGuest.id, teamId: currentGuest.team, updatedAt: new Date().toISOString() };
        state.gameSubmissions[key] = payload;
        saveState();
        toast("Respuesta enviada al archivo del juego.");
        postToSheets("saveGameSubmission", payload);
        renderCurrentRoute();
      }));
    }

    if (route === "admin") bindAdminEvents();
  }

  function bindAdminEvents() {
    $("#adminLoginForm")?.addEventListener("submit", event => {
      event.preventDefault();
      const password = new FormData(event.currentTarget).get("password");
      if ((CONFIG.LOCAL_ADMIN_PASSWORD || "") && password !== CONFIG.LOCAL_ADMIN_PASSWORD) {
        toast("Clave admin incorrecta.");
        return;
      }
      state.adminPassword = password;
      state.adminUnlocked = true;
      saveState();
      toast("Panel admin abierto.");
      renderCurrentRoute();
    });

    $("#scoreForm")?.addEventListener("submit", event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const payload = {
        ...values,
        points: Number(values.points || 0),
        adminPassword: state.adminPassword,
        timestamp: new Date().toISOString()
      };
      state.scoreEntries.push(payload);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      toast("Puntos cargados.");
      postToSheets("saveScore", payload);
      renderCurrentRoute();
    });

    $$("[data-unlock-key]").forEach(input => input.addEventListener("change", event => {
      const key = event.currentTarget.dataset.unlockKey;
      const open = event.currentTarget.checked;
      state.manualUnlocks[key] = open;
      saveState();
      toast(open ? "Candado abierto manualmente." : "Candado vuelve a su fecha original.");
      postToSheets("saveUnlock", { key, open, adminPassword: state.adminPassword, timestamp: new Date().toISOString() });
      renderCurrentRoute();
    }));

    $("#setupSheets")?.addEventListener("click", async () => {
      if (!isConfigured()) { toast("Primero pegá la URL de Apps Script en config.js."); return; }
      try {
        await jsonp("setup", { adminPassword: state.adminPassword });
        toast("Hojas inicializadas en Google Sheets.");
        syncFromSheets(true);
      } catch (error) {
        toast(`No se pudo inicializar: ${error.message}`);
      }
    });

    $("#syncNow")?.addEventListener("click", () => syncFromSheets(true));
    $("#exportJson")?.addEventListener("click", () => downloadFile("convocatoria-vani-fede-datos.json", JSON.stringify(state, null, 2), "application/json"));
    $("#exportCsv")?.addEventListener("click", () => downloadFile("rsvp-vani-fede.csv", buildRsvpCsv(), "text/csv;charset=utf-8"));
    $("#resetLocal")?.addEventListener("click", () => {
      if (!confirm("¿Borrar todos los datos locales de este navegador? Google Sheets no se borra.")) return;
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    });
  }

  function buildRsvpCsv() {
    const header = ["guestId", "nombre", "apellido", "email", "telefono", "asistencia", "traslado", "restricciones", "comentario", "updatedAt"];
    const rows = Object.entries(state.rsvps).map(([guestId, row]) => [guestId, row.firstName, row.lastName, row.email, row.phone, row.attendance, row.transport, row.diet, row.comment, row.updatedAt]);
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
