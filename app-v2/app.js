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

  // Puntos enteros por persona, equilibrados por cantidad de jugadores activos por equipo.
  // Fede, Vani y registros no jugadores/mascota quedan fuera del cálculo competitivo.
  const RSVP_POINTS_BY_TEAM = { bosque: 13, fuego: 10, luz: 14, noche: 14, agua: 13, viento: 11 };
  const PROFILE_POINTS_BY_TEAM = { bosque: 20, fuego: 15, luz: 21, noche: 21, agua: 19, viento: 16 };

  let currentGuest = null;
  let currentRoute = "inicio";
  let remoteStatus = "idle";

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
        guest.roleVisible,
        guest.displayRelation,
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
      const response = await jsonp(action, { payload: JSON.stringify(envelope) });
      setRemoteStatus("online", "Sheets conectado · guardado");
      return response?.ok !== false;
    } catch (error) {
      console.warn("Fallo escritura Sheets", error);
      state.lastRemoteError = error.message;
      saveState();
      setRemoteStatus("error", "Sheets no guardó");
      toast("No se guardó en Google Sheets. Quedó guardado localmente.");
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
    configureNavigation();
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

  function configureNavigation() {
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
    navigate("inicio");
    if (showWelcome) toast(`Acceso concedido · Equipo ${team.name}.`);
  }

  function navigate(route) {
    if (route === "ficha" || route === "juegos") route = "inicio";
    if (route === "torneo") route = "puntos";
    currentRoute = route;
    $$(".nav-tabs button").forEach(button => button.classList.toggle("active", button.dataset.route === route));
    renderCurrentRoute();
  }

  function renderCurrentRoute() {
    const routes = {
      inicio: renderHome,
      info: renderInfo,
      asistencia: renderRSVP,
      equipo: renderTeam,
      puntos: renderPointsHub,
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


  function teamLogo(team, className = "") {
    if (!team) return "";
    const cls = className ? ` ${className}` : "";
    const src = `assets/team-logos/${team.id}.png?v=22000`;
    return `<span class="team-logo${cls}" aria-label="${escapeHTML(team.name)}"><img src="${src}" alt="Logo ${escapeHTML(team.name)}" loading="lazy"></span>`;
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

  function renderHome() {
    const team = getTeam(currentGuest.team);
    const rsvp = state.rsvps[currentGuest.id];
    const rsvpDone = hasCompletedRsvp(rsvp);
    const submittedGames = Object.keys(state.gameSubmissions || {}).filter(key => key.startsWith(`${currentGuest.id}::`)).length;
    const rank = calculateRanking();
    const myRank = rank.findIndex(row => row.id === team.id) + 1;
    const myPoints = rank.find(row => row.id === team.id)?.total || 0;

    const rsvpCallout = rsvpDone ? `
      <div class="home-ok-callout">
        <div>
          <strong>✅ Asistencia registrada</strong>
          <p>Ya tenemos tu confirmación, traslado y restricciones. Podés editar tu respuesta desde Asistencia.</p>
        </div>
        <button class="ghost-button" type="button" data-go="asistencia">Ver / editar</button>
      </div>` : `
      <div class="home-rsvp-callout">
        <span class="callout-icon">✉️</span>
        <div>
          <strong>Confirmá tu asistencia</strong>
          <p>Es lo primero que necesitamos que completes. Respondé antes del <b>31/08</b>. En el formulario también vas a elegir traslado y cargar restricciones alimenticias.</p>
        </div>
        <button type="button" data-go="asistencia">Confirmar ahora</button>
      </div>`;

    return `
      ${homeStyles()}
      <section class="hero-card" style="--local-accent:${team.accent}">
        <div class="hero-copy">
          <p class="eyebrow">Archivo personal</p>
          <h3>${rsvpDone ? "Tu destino fue revelado." : "Primero confirmá. Después, sumá puntos."}</h3>
          <p>${rsvpDone ? `Has sido convocado por la fuerza de <strong>${team.name}</strong>. Tu asistencia ya quedó registrada; ahora podés ver cómo sumar puntos y preparar a tu equipo para la batalla.` : `Ya sos parte del equipo <strong>${team.name}</strong>. Mientras esperamos que todos confirmen asistencia antes del <strong>31/08</strong>, ya podés empezar a jugar y sumar puntos para tu fuerza.`}</p>
          <div class="badge-row">
            ${teamBadge(team)}
            <span class="badge muted">Capitán: ${escapeHTML(team.captain)}</span>
            <span class="badge muted">${escapeHTML(DATA.couple.dateLabel)}</span>
          </div>
          ${rsvpCallout}
        </div>
        <div class="team-medallion">
          ${teamLogo(team, "team-medallion-logo")}
          <strong>${team.name}</strong>
          <small>${escapeHTML(rsvpDone ? team.motto : "Competís contra otros 5 equipos desde ahora hasta que termine la fiesta.")}</small>
          <div class="score-chip">${rsvpDone ? `Puesto actual: ${myRank || "—"}` : "⏳ Asistencia pendiente"}</div>
        </div>
      </section>

      <section class="stats-grid">
        ${statCard("Asistencia", rsvpDone ? "Registrada" : "Pendiente", rsvpDone ? "✅" : "✉️")}
        ${statCard("Acciones enviadas", String(submittedGames), "🎲")}
        ${statCard("Puntos del equipo", String(myPoints), "🏆")}
        ${statCard("Equipo", team.name, teamLogo(team, "stat-team-logo"))}
      </section>

      ${sectionHeader("próximos pasos", rsvpDone ? "Ahora sí, a sumar puntos" : "Lo importante primero", rsvpDone ? "La asistencia ya quedó registrada. El foco pasa a sumar puntos y coordinar con tu equipo." : "La asistencia sigue siendo prioridad, pero la competencia ya empezó.")}
      <section class="grid four">
        ${actionCard("asistencia", rsvpDone ? "Asistencia confirmada" : "Confirmar asistencia", rsvpDone ? "Podés editarla cuando quieras." : "Traslado y restricciones antes del 31/08.", rsvpDone ? "✅" : "✉️", Boolean(rsvpDone))}
        ${actionCard("puntos", "Sumá puntos!", "Hub de juegos, reglas y acciones para tu equipo.", "🏆")}
        ${actionCard("equipo", `Ver ${team.name}`, "Integrantes, capitán, lema y estrategia.", teamLogo(team, "action-team-logo"))}
        ${actionCard("ranking", "Ranking general", "La tabla de fuerzas y últimos movimientos.", "🏆")}
      </section>
    `;
  }

  function homeStyles() {
    return `<style>
      .home-rsvp-callout{margin-top:24px;display:grid;grid-template-columns:auto 1fr auto;gap:18px;align-items:center;border:1px solid rgba(216,185,106,.60);border-radius:24px;padding:20px;background:linear-gradient(135deg,rgba(216,185,106,.20),rgba(24,39,25,.78));box-shadow:0 18px 50px rgba(216,185,106,.10)}
      .home-rsvp-callout .callout-icon{font-size:34px}.home-rsvp-callout strong{display:block;font-family:Georgia,serif;font-size:28px;color:var(--cream);margin-bottom:5px}.home-rsvp-callout p{margin:0;color:rgba(247,238,217,.78);font-weight:800;line-height:1.45}.home-rsvp-callout button{white-space:nowrap}
      .home-ok-callout{margin-top:24px;display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid rgba(189,240,182,.28);border-radius:24px;padding:18px 20px;background:rgba(189,240,182,.08)}
      .home-ok-callout strong{display:block;font-family:Georgia,serif;font-size:24px;color:var(--cream);margin-bottom:4px}.home-ok-callout p{margin:0;color:var(--muted);font-weight:800;line-height:1.45}
      @media(max-width:850px){.home-rsvp-callout{grid-template-columns:1fr}.home-ok-callout{flex-direction:column;align-items:flex-start}}
    </style>`;
  }

  function statCard(label, value, icon) {
    return `<article class="stat-card"><span>${icon}</span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></article>`;
  }

  function renderInfo() {
    const locationOpen = isUnlocked("location");
    const menuOpen = isUnlocked("menu");
    const calendarUrl = "https://calendar.google.com/calendar/event?action=TEMPLATE&tmeid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&tmsrc=federicosanti91%40gmail.com";

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
        <a class="info-calendar-button" href="${calendarUrl}" target="_blank" rel="noopener">📅 AGENDALO!</a>
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
          <p>Vamos a poner una combi / micro que saldrá desde el <strong>Obelisco</strong> y llevará a los invitados hasta el lugar secreto.</p>
          <div class="micro-steps"><span>Subís en el Obelisco</span><span>→</span><span>Bajás en el bosque</span></div>
          <p>Regreso previsto: <strong>03:00 hs</strong>.</p>
          <small>Si querés recibir información de la combi, marcá “Necesito info de combi” al confirmar asistencia.</small>
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

      <section class="section-card"><div class="card-title-row"><h4>Preguntas rápidas</h4><span class="badge muted">FAQ</span></div><div class="faq-grid"><div><strong>¿Dónde es?</strong><p>Todavía es secreto. El destino final se revelará más adelante.</p></div><div><strong>¿Hay combi?</strong><p>Sí. Saldrá desde el Obelisco y volverá al finalizar la fiesta.</p></div><div><strong>¿A qué hora es?</strong><p>El evento es de 18:00 a 03:00 hs.</p></div><div><strong>¿Qué calzado conviene?</strong><p>Algo elegante, pero cómodo para caminar sobre pasto.</p></div></div></section>`;
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
    const editing = Boolean(state.rsvpEditMode || !hasSaved);
    const deadlineLabel = "31 de agosto de 2026";
    const calendarUrl = "https://calendar.google.com/calendar/event?action=TEMPLATE&tmeid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&tmsrc=federicosanti91%40gmail.com";
    const savedTransport = saved.transport === "auto" ? "particular" : saved.transport;

    if (hasSaved && !editing) {
      return `
        ${rsvpStyles()}
        ${sectionHeader("confirmación", "Asistencia registrada", "Tu respuesta quedó guardada. Podés revisarla y cambiarla cuando quieras desde esta misma sección.")}
        <section class="section-card form-card rsvp-thank-card">
          <div class="rsvp-thank-grid">
            <div>
              <div class="rsvp-okmark">✓</div>
              <h4 class="rsvp-thank-title">${rsvpThanksTitle(saved)}</h4>
              <p class="rsvp-thank-lead">${rsvpThanksText(saved)}</p>

              <div class="rsvp-summary-grid">
                ${summaryLine("Nombre", `${saved.firstName || currentGuest.firstName} ${saved.lastName || currentGuest.lastName}`.trim())}
                ${summaryLine("Mail", saved.email || "Sin cargar")}
                ${summaryLine("Teléfono", saved.phone || "Sin cargar")}
                ${summaryLine("Asistencia", attendanceLabel(saved.attendance))}
                ${summaryLine("Traslado / combi", transportLabel(saved.transport))}
                ${summaryLine("Restricciones", saved.diet || "Sin restricciones cargadas")}
                ${summaryLine("Comentario", saved.comment || "Sin comentario cargado", true)}
              </div>

              <div class="rsvp-actions-row">
                <button id="editRsvp" type="button">Editar mi respuesta</button>
                <a class="ghost-button rsvp-calendar-link" href="${calendarUrl}" target="_blank" rel="noopener">📅 AGENDALO!</a>
                <button id="syncRsvp" type="button" class="ghost-button">Sincronizar datos</button>
              </div>

              <p class="form-note">Última edición: ${formatDateLabel(saved.updatedAt)}</p>
            </div>

            <aside class="rsvp-side-note">
              <h4>¿Necesitás cambiar algo?</h4>
              <p>Podés editar tu respuesta y volver a enviarla. La app va a guardar la nueva versión y mostrará siempre la última actualización.</p>
              <p>Si cambian tus restricciones alimentarias, traslado o asistencia, actualizalo acá para poder organizar todo mejor.</p>
            </aside>
          </div>
        </section>`;
    }

    return `
      ${rsvpStyles()}
      ${sectionHeader("confirmación", hasSaved ? "Editar asistencia" : "Confirmar asistencia", `Responder antes del ${deadlineLabel}.`)}
      <section class="calendar-strip">
        <div>
          <strong>📅 AGENDALO!</strong>
          <p>Guardá el evento en Google Calendar para tener fecha, horario y recordatorio a mano.</p>
        </div>
        <a href="${calendarUrl}" target="_blank" rel="noopener">Guardar en Google Calendar</a>
      </section>

      <form id="rsvpForm" class="section-card form-card">
        ${hasSaved ? `<div class="warning-ribbon">Estás editando una respuesta ya registrada. Al guardar, se enviará una nueva actualización.</div>` : ""}
        <div class="form-grid">
          ${field("firstName", "Nombre", saved.firstName || currentGuest.firstName, "text", true)}
          ${field("lastName", "Apellido", saved.lastName || currentGuest.lastName, "text", true)}
          ${field("email", "Mail", saved.email || currentGuest.email || "", "email", true)}
          ${field("phone", "Teléfono", saved.phone || "", "tel", false)}

          <fieldset class="choice-field">
            <legend>Confirmo asistencia</legend>
            <div class="choice-group">
              ${choicePill("attendance", "si", "Sí, voy", saved.attendance, true)}
              ${choicePill("attendance", "no", "No puedo asistir", saved.attendance, true)}
              ${choicePill("attendance", "a-confirmar", "A confirmar", saved.attendance, true)}
            </div>
          </fieldset>

          <label>Traslado / combi
            <select name="transport">
              ${option("", "Seleccionar", savedTransport)}
              ${option("particular", "De forma particular", savedTransport)}
              ${option("combi", "Necesito info de combi", savedTransport)}
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
          <button type="submit">${hasSaved ? "Guardar cambios" : "Guardar asistencia"}</button>
          ${hasSaved ? `<button id="cancelRsvpEdit" type="button" class="ghost-button">Cancelar edición</button>` : ""}
          <span class="form-note">${hasSaved ? `Última edición: ${formatDateLabel(saved.updatedAt)}` : "Todavía no registrado."}</span>
        </div>
      </form>`;
  }

  function rsvpStyles() {
    return `<style>
      .calendar-strip{display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid var(--line);border-radius:24px;padding:18px 22px;margin:0 0 20px;background:linear-gradient(135deg,#2a341dcc,#0c130dcc)}
      .calendar-strip strong{display:block;color:#f3d37c;font-weight:1000;letter-spacing:.08em}.calendar-strip p{margin:4px 0 0;color:var(--muted);font-weight:800}.calendar-strip a,.rsvp-calendar-link{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:999px;border:1px solid rgba(255,242,201,.2);padding:13px 18px;background:linear-gradient(135deg,#efd27f,#c89d45);color:#1c1406;font-weight:1000;white-space:nowrap}
      .choice-field{border:0;padding:0;margin:0}.choice-field legend{color:var(--cream);font-weight:900;margin:0 0 10px}.choice-group{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.choice-pill{cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center;min-height:54px;border-radius:999px;border:1px solid rgba(255,242,201,.16);background:#07100ae0;color:var(--cream);font-weight:1000;text-align:center;padding:14px 12px;transition:.18s ease}.choice-pill input{position:absolute;opacity:0;pointer-events:none}.choice-pill:has(input:checked){background:linear-gradient(135deg,#efd27f,#c89d45);color:#1c1406;border-color:transparent;box-shadow:0 0 0 3px rgba(231,194,103,.18)}
      .rsvp-thank-card{padding:28px}.rsvp-thank-grid{display:grid;grid-template-columns:1.35fr .65fr;gap:24px;align-items:stretch}.rsvp-okmark{width:78px;height:78px;border-radius:50%;display:grid;place-items:center;background:#bdf0b61a;border:1px solid #bdf0b666;color:#bdf0b6;font-size:40px;font-weight:1000;margin-bottom:16px}.rsvp-thank-title{font-family:Georgia,serif;font-size:clamp(30px,4vw,42px);line-height:1;margin:0 0 10px;color:var(--cream)}.rsvp-thank-lead{color:var(--muted);font-weight:800;font-size:17px;line-height:1.45;max-width:760px}.rsvp-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:24px}.rsvp-summary-grid .wide{grid-column:1/-1}.summary-item{border:1px solid rgba(255,242,201,.14);border-radius:18px;padding:16px;background:#07100aaa}.summary-item strong{display:block;color:#f3d37c;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}.summary-item p{margin:0;color:var(--cream);font-weight:1000;word-break:break-word}.rsvp-side-note{border:1px solid rgba(255,242,201,.16);border-radius:24px;padding:22px;background:#050b08cc}.rsvp-side-note h4{font-family:Georgia,serif;font-size:26px;margin:0 0 12px}.rsvp-side-note p{color:var(--muted);font-weight:800;line-height:1.5}.rsvp-actions-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}
      @media(max-width:850px){.calendar-strip{align-items:flex-start;flex-direction:column}.calendar-strip a{width:100%}.choice-group{grid-template-columns:1fr}.rsvp-thank-grid{grid-template-columns:1fr}.rsvp-summary-grid{grid-template-columns:1fr}}
    </style>`;
  }

  function choicePill(name, value, label, selected, required = false) {
    return `<label class="choice-pill"><input type="radio" name="${escapeHTML(name)}" value="${escapeHTML(value)}" ${value === selected ? "checked" : ""} ${required ? "required" : ""}><span>${escapeHTML(label)}</span></label>`;
  }

  function summaryLine(label, value, wide = false) {
    return `<div class="summary-item ${wide ? "wide" : ""}"><strong>${escapeHTML(label)}</strong><p>${escapeHTML(value || "Sin cargar")}</p></div>`;
  }



  function hasCompletedRsvp(row) {
    return Boolean(row && row.updatedAt && row.attendance);
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
      });
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
    const labels = { "si": "Sí, voy", "no": "No puedo asistir", "a-confirmar": "A confirmar" };
    return labels[value] || value || "Sin cargar";
  }

  function transportLabel(value) {
    const labels = { "particular": "De forma particular", "auto": "De forma particular", "combi": "Necesito info de combi", "duermo": "Duermo en la estancia" };
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


  function renderTeam() {
    const team = getTeam(currentGuest.team);
    const members = DATA.guests.filter(guest => guest.team === team.id).sort(sortGuestsForDisplay);
    const activePlayers = teamCompetitionMembers(team.id).length;
    const confirmed = completedRsvpMembers(team.id).length;
    return `
      ${captainGuestStyles()}
      ${sectionHeader("mi fuerza", `Equipo ${team.name}`, `${team.group}. Capitán: ${team.captain}.`)}
      <section class="team-hero section-card" style="--local-accent:${team.accent}">
        <div class="team-symbol">${teamLogo(team, "team-symbol-logo")}</div>
        <div><h3>${team.name}</h3><p>${escapeHTML(team.motto)}</p><div class="badge-row"><span class="badge">${escapeHTML(team.colorName)}</span><span class="badge muted">${escapeHTML(team.trait)}</span><span class="badge muted">Jugadores activos: ${activePlayers}</span></div></div>
      </section>
      <section class="grid two">
        <article class="section-card"><h4>Formación</h4><p class="form-note">Capitán primero. Fede y Vani no cuentan para los puntos competitivos.</p><div class="guest-list">${members.map(guestPill).join("")}</div></article>
        <article class="section-card"><h4>Estado del equipo</h4><p><strong>Asistencia:</strong> ${confirmed} de ${activePlayers} jugadores activos.</p><p><strong>Puntos:</strong> el equipo suma desde asistencia, desafíos y juegos físicos cargados por Admin.</p><hr><p><strong>Estrategia:</strong> ${escapeHTML(team.strategy)}</p><p><strong>Rol del capitán:</strong> activar al equipo, responder consignas, decidir comodines y cargar mística.</p></article>
      </section>`;
  }

  function captainGuestStyles() {
    return `<style>
      .guest-pill.captain-pill{border-color:rgba(216,185,106,.70);background:linear-gradient(135deg,rgba(216,185,106,.16),rgba(24,39,25,.72));box-shadow:0 0 0 1px rgba(216,185,106,.10) inset}
      .captain-label{display:inline-flex;align-items:center;gap:6px;margin-top:5px;padding:4px 8px;border-radius:999px;background:rgba(216,185,106,.14);color:#f2d482;font-weight:950;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
    </style>`;
  }

  function guestPill(guest) {
    const team = getTeam(guest.team);
    const captain = isGuestCaptain(guest);
    const visibleRole = guest.roleVisible || guest.displayRelation || guest.relation || guest.role || "invitado";
    const aliasText = guest.alias ? `${guest.alias} · ${visibleRole}` : visibleRole;
    return `<div class="guest-pill ${captain ? "captain-pill" : ""}"><span>${captain ? "👑" : teamLogo(team, "guest-pill-logo")}</span><div><strong>${escapeHTML(`${guest.firstName} ${guest.lastName}`.trim())}</strong><small>${escapeHTML(aliasText)}</small>${captain ? `<span class="captain-label">Capitán</span>` : ""}</div></div>`;
  }

  function renderPointsHub() {
    const team = getTeam(currentGuest.team);
    const activePlayers = teamSizeForPoints(team.id);
    const rsvpPoints = rsvpPointsForTeam(team.id);
    const rsvp = state.rsvps[currentGuest.id];
    const currentGuestCanScore = isCompetitionGuest(currentGuest);
    const rsvpDone = currentGuestCanScore && hasCompletedRsvp(rsvp);
    const rsvpDoneCount = completedRsvpMembers(team.id).length;
    const rsvpCurrentPoints = rsvpDoneCount * rsvpPoints;
    const rsvpMaxPoints = activePlayers * rsvpPoints;
    const rank = calculateRanking();
    const myPoints = rank.find(row => row.id === team.id)?.total || 0;

    return `
      ${pointsHubStyles()}
      ${sectionHeader("sumá puntos!", "La competencia empieza ahora", "Mientras esperamos que todos confirmen asistencia, cada equipo puede empezar a sumar puntos. Algunas consignas son individuales, otras son de equipo y otras se activarán más adelante.")}

      <section class="points-hero section-card" style="--local-accent:${team.accent}">
        <div>
          <p class="eyebrow">Equipo ${escapeHTML(team.name)}</p>
          <h3>Tu aporte suma para toda la fuerza.</h3>
          <p>Vas a competir contra otros 5 equipos desde ahora mismo hasta que finalice la fiesta. Cada acción suma distinto según tu equipo para mantener la competencia equilibrada.</p>
          <div class="badge-row">${teamBadge(team, team.name)}<span class="badge muted">Capitán: ${escapeHTML(team.captain)}</span><span class="badge muted">Jugadores activos: ${activePlayers}</span><span class="badge muted">Puntos actuales: ${myPoints}</span></div>
        </div>
        <div class="points-medal"><span>🏆</span><strong>${myPoints}</strong><small>puntos actuales</small></div>
      </section>

      <section class="grid three points-rules">
        <article class="section-card"><span class="card-icon">⚖️</span><h4>Puntos equilibrados</h4><p>Cada equipo tiene una cantidad distinta de integrantes, por eso cada jugador suma puntos enteros personalizados para su fuerza.</p></article>
        <article class="section-card"><span class="card-icon">👥</span><h4>Jugadores activos</h4><p>Fede y Vani no cuentan para el cálculo competitivo. El puntaje se calcula sobre los invitados jugadores de cada equipo.</p></article>
        <article class="section-card"><span class="card-icon">🎉</span><h4>Hasta el final</h4><p>Los puntos se acumulan desde ahora y siguen durante la fiesta con juegos físicos, bonus y sorpresas.</p></article>
      </section>

      <section class="section-card">
        <div class="card-title-row"><h4>Qué podés hacer ahora</h4><span class="badge">Primera tanda</span></div>
        ${pointsAction("✉️", "Confirmar asistencia antes del 31/08", currentGuestCanScore ? (rsvpDone ? `Ya sumaste puntos para ${team.name}. Podés editar tu respuesta, pero no suma dos veces.` : `Al completar esta acción sumás puntos para ${team.name}. También elegís traslado y cargás restricciones alimenticias.`) : "Los novios no suman puntos, pero pueden revisar el estado del equipo.", "Suma puntos", rsvpDone, "asistencia", `${rsvpDoneCount} de ${activePlayers} confirmaron`)}
        ${pointsAction("🎵", "Proponer canción de equipo", "Próximamente cada equipo podrá proponer un tema que represente a su fuerza.", "Próximamente", false, "equipo", "Consigna de equipo")}
        ${pointsAction("📸", "Foto creativa del equipo", "Cuando se habilite, cada equipo podrá mandar una foto o composición temática.", "Próximamente", false, "equipo", "Consigna de equipo")}
        ${pointsAction("⚔️", "Desafío sorpresa", "Se habilitarán consignas nuevas hasta el día de la fiesta.", "Próximamente", false, "equipo", "Candado activo")}
      </section>

      <section class="section-card points-note"><span class="card-icon">⚔️</span><h4>Importante</h4><p>Editar una respuesta no vuelve a sumar puntos. Los puntos de asistencia se calculan una sola vez por jugador activo.</p></section>
    `;
  }

  function pointsAction(icon, title, text, points, done, route, progressText = "") {
    return `<article class="points-action ${done ? "done" : ""}"><div class="points-left"><span>${icon}</span><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p>${progressText ? `<small class="points-progress">${escapeHTML(progressText)}</small>` : ""}${done ? `<small class="points-done-note">✅ Ya sumaste estos puntos</small>` : ""}</div></div><div class="points-right"><b>${escapeHTML(points)}</b><button type="button" data-go="${escapeHTML(route === "equipo" ? "equipo" : route)}">${done ? "Ver / editar" : route === "asistencia" ? "Hacer" : "Ver"}</button></div></article>`;
  }

  function pointsHubStyles() {
    return `<style>
      .points-hero{display:grid;grid-template-columns:1fr auto;gap:22px;align-items:center;background:linear-gradient(135deg,rgba(216,185,106,.16),rgba(24,39,25,.84));border-color:rgba(216,185,106,.45)}.points-hero h3{font-size:38px;margin:4px 0 10px}.points-hero p{max-width:780px}.points-medal{width:170px;height:170px;border-radius:32px;border:1px solid rgba(247,238,217,.18);display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,9,5,.34);text-align:center}.points-medal span{font-size:42px}.points-medal strong{font-family:Georgia,serif;font-size:46px;color:#f0cd75;line-height:1}.points-medal small{color:var(--muted);font-weight:900}.points-rules{margin-top:16px}.points-action{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;border:1px solid rgba(247,238,217,.14);border-radius:22px;padding:18px;background:rgba(4,9,5,.26);margin-top:12px}.points-action.done{border-color:rgba(189,240,182,.28);background:rgba(189,240,182,.07)}.points-done-note,.points-progress{display:inline-block;margin-top:8px;font-weight:900}.points-done-note{color:#bdf0b6}.points-progress{color:#f0cd75}.points-left{display:flex;gap:15px;align-items:flex-start}.points-left>span{font-size:30px}.points-left strong{font-size:18px}.points-left p{margin:5px 0 0;color:var(--muted);font-weight:780;line-height:1.45}.points-right{display:flex;gap:12px;align-items:center}.points-right b{font-family:Georgia,serif;font-size:24px;color:#f0cd75;white-space:nowrap}.points-right button{white-space:nowrap}.points-note{margin-top:16px;border-color:rgba(216,185,106,.40);background:rgba(216,185,106,.10)}
      @media(max-width:850px){.points-hero{grid-template-columns:1fr}.points-medal{width:100%;height:auto;padding:22px}.points-action{grid-template-columns:1fr}.points-right{justify-content:space-between}}
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
      <section class="section-card"><h4>Últimos movimientos</h4>${allPointEntries().length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Equipo</th><th>Movimiento</th><th>Comentario</th></tr></thead><tbody>${allPointEntries().slice(-12).reverse().map(entry => `<tr><td>${formatDateLabel(entry.timestamp || entry.submittedAt || entry.updatedAt)}</td><td>${escapeHTML(gameName(entry.gameId))}</td><td>${escapeHTML(getTeam(entry.teamId).name)}</td><td>Sumó puntos</td><td>${escapeHTML(entry.comment || "El equipo sumó puntos.")}</td></tr>`).join("")}</tbody></table></div>` : `<p>Todavía no hay movimientos cargados.</p>`}</section>`;
  }

  function rankRow(row, index) {
    const team = getTeam(row.id);
    const pos = index + 1;
    return `<article class="rank-item" style="--local-accent:${team.accent}"><span class="rank-pos">${pos}</span><span class="rank-emoji">${teamLogo(team, "rank-team-logo")}</span><div><strong>${team.name}</strong><small>${team.group}</small></div><div class="rank-points"><strong>${row.total}</strong><small>puntos</small></div></article>`;
  }

  function calculateRanking() {
    const totals = Object.keys(DATA.teams).map(id => ({ id, total: 0 }));
    for (const entry of allPointEntries()) {
      const row = totals.find(item => item.id === entry.teamId);
      if (row) row.total += Number(entry.points || 0);
    }
    return totals.sort((a, b) => b.total - a.total || DATA.teams[a.id].name.localeCompare(DATA.teams[b.id].name));
  }

  function gameName(id) {
    if (id === "auto-rsvp") return "Confirmación de asistencia";
    if (id === "discrecional-fede-vani") return "Puntos a discreción";
    if (["reset-discretionary-clear-marker", "reset-discrecional-fede-vani"].includes(id)) return "Limpieza de puntos discrecionales";
    if (["reset-total-clear-marker", "reset-total-fede-vani"].includes(id)) return "Limpieza general de puntos";
    return DATA.games.find(game => game.id === id)?.title || id || "Juego";
  }

  function renderGuests() {
    const open = isUnlocked("guestMap");
    const grouped = Object.values(DATA.teams).map(team => ({ team, guests: DATA.guests.filter(guest => guest.team === team.id).sort(sortGuestsForDisplay) }));
    return `
      ${captainGuestStyles()}
      ${sectionHeader("organigrama", "Mapa de invitados", "Un quién-es-quién de la noche, con alias, equipos y personajes clave. Los capitanes aparecen primeros en cada fuerza.")}
      ${open ? "" : lockedNotice("guestMap")}
      <section class="guest-map">${grouped.map(group => `
        <article class="section-card team-column" style="--local-accent:${group.team.accent}">
          <h4 class="team-heading">${teamLogo(group.team, "team-heading-logo")}<span>${group.team.name}</span></h4>
          <small>${escapeHTML(group.team.group)}</small>
          <div class="guest-list">${group.guests.map(guestPill).join("")}</div>
        </article>`).join("")}</section>`;
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
        ${statCard("Puntajes", String(allPointEntries().length), "🏆")}
        ${statCard("Sheets", isConfigured() ? "Activo" : "Pendiente", isConfigured() ? "✅" : "⚠️")}
      </section>
      <section class="grid two">
        <form id="scoreForm" class="section-card form-card">
          <h4>Sumar puntos a discreción</h4>
          <p class="form-note">Para uso de Fede y Vani durante la previa y la noche de la boda. Estos puntos se cargan por equipo, no por persona.</p>
          <input type="hidden" name="gameId" value="discrecional-fede-vani">
          <label>Equipo<select name="teamId" required>${Object.values(DATA.teams).map(team => option(team.id, team.name, "")).join("")}</select></label>
          <label>Puntos<input name="points" type="number" step="1" placeholder="Ej: 50, 100 o -20" required></label>
          <label>Motivo / comentario<textarea name="comment" placeholder="Ej: ganó juego físico, bonus por actitud, penalización, decisión de Fede y Vani..."></textarea></label>
          <button type="submit">Sumar puntos</button>
        </form>
        <article class="section-card">
          <h4>Candados</h4>
          <div class="unlock-list">${Object.entries(DATA.unlocks).map(([key, unlock]) => `<label class="toggle-row"><span><strong>${escapeHTML(unlock.title)}</strong><small>${escapeHTML(unlock.teaser)}</small></span><input type="checkbox" data-unlock-key="${key}" ${isUnlocked(key) ? "checked" : ""}></label>`).join("")}</div>
        </article>
      </section>
      ${resetButtonStyles()}
      <section class="section-card admin-reset-panel">
        <h4>Reseteo de puntos</h4>
        <p>Estos botones son para Fede y Vani. Limpian el ranking y también ocultan los movimientos anteriores de “Últimos movimientos”. No borran RSVP ni datos de invitados.</p>
        <div class="admin-reset-actions">
          <button id="resetDiscretionaryPoints" type="button" class="danger-button">Resetear puntos discrecionales</button>
          <button id="resetAllPoints" type="button" class="danger-button">Resetear todos los puntos</button>
        </div>
        <p class="reset-note">La limpieza se guarda como marcador técnico oculto, para que al sincronizar no vuelvan a aparecer movimientos viejos.</p>
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

      $("#syncRsvp")?.addEventListener("click", () => syncFromSheets(true));

      $("#rsvpForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = { ...values, guestId: currentGuest.id, teamId: currentGuest.team, updatedAt: new Date().toISOString() };
        state.rsvps[currentGuest.id] = payload;
        state.rsvpEditMode = false;
        saveState();
        toast("Asistencia guardada. Tu equipo sumó puntos.");
        renderCurrentRoute();
        postToSheets("saveRsvp", payload);
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

      $("#profileForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        const payload = { ...values, guestId: currentGuest.id, teamId: currentGuest.team, updatedAt: new Date().toISOString() };
        state.profiles[currentGuest.id] = payload;
        state.profileEditMode = false;
        saveState();
        renderCurrentRoute();
        toast("Ficha secreta guardada. Sumaste puntos para tu equipo.");
        postToSheets("saveProfile", payload);
      });
    }

    if (route === "puntos") {
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
        adminName: "Fede y Vani",
        timestamp: new Date().toISOString()
      };
      state.scoreEntries.push(payload);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      toast("Puntos cargados.");
      postToSheets("saveScore", payload);
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
      await syncFromSheets(false);
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
      await syncFromSheets(false);
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
