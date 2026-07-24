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
  let countdownTimer = null;
  let selectedTeamViewId = null;
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

  function guestFullName(guest) {
    return `${guest?.firstName || ""} ${guest?.lastName || ""}`.replace(/\s+/g, " ").trim();
  }

  function findGuest(query) {
    const wanted = normalize(query);
    if (!wanted) return null;

    const exactMatches = DATA.guests.filter(guest => {
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
    const wanted = normalize(query);
    if (wanted.length < 2) return [];

    return DATA.guests
      .filter(guest => {
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
        const alias = normalize(guest.alias) && normalize(guest.alias) !== normalize(guest.firstName)
          ? `También figura como “${escapeHTML(guest.alias)}”`
          : "Invitación personal";
        const initial = escapeHTML((guest.firstName || guest.lastName || "V").charAt(0).toUpperCase());
        return `
          <button id="guest-option-${index}" class="guest-suggestion" type="button" role="option" data-guest-id="${escapeHTML(guest.id)}" aria-selected="false">
            <span class="guest-suggestion-mark" aria-hidden="true">${initial}</span>
            <span><strong>${escapeHTML(fullName)}</strong><small>${alias}</small></span>
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
    $("#menuButton")?.addEventListener("click", () => {
      const isOpen = $("#mainMenu")?.classList.contains("open");
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
        message.textContent = suggestionMatches.length
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
      currentGuest = null;
      state.currentGuestId = null;
      saveState();
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
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    $("#syncButton").addEventListener("click", () => syncFromSheets(true));

    $$(".nav-tabs button[data-route]").forEach(button => {
      button.addEventListener("click", () => {
        if (button.dataset.route === "equipo") selectedTeamViewId = currentGuest?.team || null;
        navigate(button.dataset.route);
        closeMenu();
      });
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
    $("#welcomeTitle").textContent = `Hola, ${guest.firstName}`;
    $("#welcomeSub").textContent = `Equipo ${team.name}`;
    navigate("inicio");
    if (showWelcome) toast(`Acceso concedido · Equipo ${team.name}.`);
  }

  function navigate(route) {
    if (route === "ficha" || route === "juegos" || route === "info") route = "inicio";
    if (route === "torneo") route = "puntos";
    currentRoute = route;
    $$(".nav-tabs button[data-route]").forEach(button => {
      const active = button.dataset.route === route;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    renderCurrentRoute();
  }

  function renderCurrentRoute() {
    const routes = {
      inicio: renderHome,
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
      pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
      bus: '<rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 7h8"/><circle cx="8" cy="18" r="1"/><circle cx="16" cy="18" r="1"/>',
      dress: '<path d="M10 3h4l1 4-2 2 4 11H7l4-11-2-2 1-4Z"/><path d="M9 7h6"/>',
      calendarPlus: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M12 13v5M9.5 15.5h5"/>',
      checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/>',
      ranking: '<path d="M5 20V10h4v10"/><path d="M10 20V4h4v16"/><path d="M15 20v-7h4v7"/>',
      play: '<path d="M8 5v14l11-7-11-7Z"/>'
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

  function renderHome() {
    const team = getTeam(currentGuest.team);
    const rsvp = state.rsvps[currentGuest.id];
    const rsvpDone = hasCompletedRsvp(rsvp);
    const locationOpen = isUnlocked("location");
    const menuOpen = isUnlocked("menu");
    const rank = calculateRanking();
    const myRank = rank.findIndex(row => row.id === team.id) + 1;
    const myPoints = rank.find(row => row.id === team.id)?.total || 0;
    const rankingStarted = rank.some(row => Number(row.total || 0) !== 0);
    const visibleRank = rankingStarted ? myRank : "—";
    const calendarUrl = "https://www.google.com/calendar/event?eid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&ctz=America/Argentina/Buenos_Aires";
    const deadline = CONFIG.RSVP_DEADLINE_LABEL || "31 de agosto de 2026";

    const now = new Date();
    const eventDate = new Date(DATA.couple.eventDate);
    const dayMs = 24 * 60 * 60 * 1000;
    const daysToEvent = Math.ceil((eventDate.getTime() - now.getTime()) / dayMs);
    const eventDay = now.getFullYear() === eventDate.getFullYear()
      && now.getMonth() === eventDate.getMonth()
      && now.getDate() === eventDate.getDate();
    const nearEvent = !eventDay && daysToEvent > 0 && daysToEvent <= 30;

    let primaryAction;
    if (!rsvpDone) {
      primaryAction = {
        tone: "pending",
        icon: "mail",
        kicker: "Tu próximo paso",
        title: "Confirmá tu asistencia",
        text: `Respondé antes del ${deadline}. Ahí también podés indicar traslado y restricciones alimentarias.`,
        button: "Confirmar asistencia",
        attr: 'data-go="asistencia"'
      };
    } else if (eventDay) {
      primaryAction = {
        tone: "today",
        icon: "sparkle",
        kicker: "Hoy es el gran día",
        title: "Todo listo para celebrar",
        text: "Revisá horarios, traslado y novedades importantes antes de salir.",
        button: "Ver datos clave",
        attr: 'data-scroll="homeEssential"'
      };
    } else if (nearEvent) {
      primaryAction = {
        tone: "soon",
        icon: "hourglass",
        kicker: "Falta poco",
        title: `${daysToEvent} ${daysToEvent === 1 ? "día" : "días"} para el casamiento`,
        text: "Revisá horario, traslado, vestimenta y la información disponible del lugar.",
        button: "Ver datos clave",
        attr: 'data-scroll="homeEssential"'
      };
    } else {
      primaryAction = {
        tone: "play",
        icon: "star",
        kicker: "Tu próximo desafío",
        title: "Tu equipo ya está jugando",
        text: `Descubrí las acciones disponibles y ayudá a ${team.name} a sumar puntos.`,
        button: "Ver cómo sumar puntos",
        attr: 'data-go="puntos"'
      };
    }

    const secondTeamAction = rsvpDone && !nearEvent && !eventDay
      ? { route: "ranking", label: "Ver ranking" }
      : { route: "puntos", label: "Sumá puntos" };

    return `
      ${homeStyles()}

      <section id="homeCountdown" class="home-countdown" aria-label="Cuenta regresiva para el casamiento">
        <span id="countdownLabel" class="home-countdown-label">Faltan</span>
        <div class="home-countdown-values">
          <span><strong id="countdownDays">—</strong><small>días</small></span>
          <i aria-hidden="true">:</i>
          <span><strong id="countdownHours">—</strong><small>horas</small></span>
          <i aria-hidden="true">:</i>
          <span><strong id="countdownMinutes">—</strong><small>min</small></span>
        </div>
        <small class="home-countdown-date">24 · 10 · 2026 · 18:00</small>
      </section>

      <section class="home-welcome" style="--local-accent:${team.accent}">
        <div class="home-welcome-logo">${teamLogo(team, "home-team-logo")}</div>
        <div class="home-welcome-copy">
          <p class="home-kicker">Tu espacio personal</p>
          <h3>Bienvenido al equipo ${escapeHTML(team.name)}</h3>
          <p>Todo para el gran día, en un solo lugar.</p>
          <div class="home-meta">
            <span>Capitanía: <strong>${escapeHTML(team.captain)}</strong></span>
            <span>24 · 10 · 2026</span>
          </div>
        </div>
      </section>

      ${rsvpDone ? `
        <button class="home-rsvp-confirmed" type="button" data-go="asistencia">
          ${uiIcon("checkCircle")}
          <span>${rsvp.attendance === "si" ? "Asistencia confirmada" : "Respuesta de asistencia registrada"}</span>
        </button>` : ""}

      <section class="home-primary-action home-primary-action--${primaryAction.tone}">
        <span class="home-primary-icon">${uiIcon(primaryAction.icon)}</span>
        <div class="home-primary-copy">
          <small>${escapeHTML(primaryAction.kicker)}</small>
          <h3>${escapeHTML(primaryAction.title)}</h3>
          <p>${escapeHTML(primaryAction.text)}</p>
        </div>
        <button type="button" ${primaryAction.attr}>${escapeHTML(primaryAction.button)}</button>
      </section>

      <section id="homeEssential" class="home-essential" aria-labelledby="homeEssentialTitle">
        <div class="home-section-heading">
          <div>
            <p class="home-kicker">Información práctica</p>
            <h3 id="homeEssentialTitle">Lo esencial</h3>
          </div>
          <a class="home-calendar-link" href="${calendarUrl}" target="_blank" rel="noopener">${uiIcon("calendarPlus")}<span>Agendalo</span></a>
        </div>

        <div class="home-essential-card">
          <article class="home-essential-row">
            <span class="home-essential-icon">${uiIcon("calendar")}</span>
            <div><small>Fecha y horario</small><strong>Sábado 24 de octubre</strong><p>18:00 a 03:00</p></div>
          </article>
          <article class="home-essential-row">
            <span class="home-essential-icon">${uiIcon("pin")}</span>
            <div><small>Lugar</small><strong>${locationOpen ? escapeHTML(DATA.couple.placeName) : "Ubicación reservada"}</strong><p>${locationOpen ? escapeHTML(DATA.couple.placeArea) : "Se revelará más cerca de la fecha."}</p></div>
          </article>
          <article class="home-essential-row">
            <span class="home-essential-icon">${uiIcon("bus")}</span>
            <div><small>Traslado</small><strong>Combi desde el Obelisco</strong><p>Habrá ida y regreso previsto a las 03:00.</p></div>
          </article>
          <article class="home-essential-row">
            <span class="home-essential-icon">${uiIcon("dress")}</span>
            <div><small>Vestimenta</small><strong>Elegante festivo</strong><p>Habrá pasto: elegí calzado cómodo.</p></div>
          </article>
        </div>

        <details class="home-details">
          <summary><span>Ver todos los detalles</span><i aria-hidden="true">⌄</i></summary>
          <div class="home-details-content">
            <article><strong>Ubicación</strong><p>${locationOpen ? `${escapeHTML(DATA.couple.placeName)}, ${escapeHTML(DATA.couple.placeArea)}.` : "La dirección exacta y el mapa se habilitarán más adelante."}</p></article>
            <article><strong>Traslado</strong><p>Al confirmar asistencia podés pedir información de la combi desde el Obelisco.</p></article>
            <article><strong>Para estar cómodo</strong><p>Puede refrescar de noche. Recomendamos abrigo liviano y evitar tacos finos.</p></article>
            <article><strong>Menú</strong><p>${menuOpen ? "Recepción, cena, postre y trasnoche." : "Se revelará más adelante. Cargá cualquier restricción en Asistencia."}</p></article>
          </div>
        </details>
      </section>

      <section class="home-team-card" style="--local-accent:${team.accent}">
        <div class="home-team-identity">
          ${teamLogo(team, "home-team-card-logo")}
          <div><small>Tu equipo</small><h3>${escapeHTML(team.name)}</h3><p>${rankingStarted ? "La competencia está en marcha." : "Los primeros movimientos aparecerán acá."}</p></div>
        </div>
        <div class="home-team-score" aria-label="Estado del equipo">
          <span><b>${myPoints}</b><small>Puntos</small></span>
          <span><b>${visibleRank}</b><small>Puesto</small></span>
        </div>
        <div class="home-team-actions">
          <button class="ghost-button" type="button" data-go="equipo">Ver mi equipo</button>
          <button type="button" data-go="${secondTeamAction.route}">${secondTeamAction.label}</button>
        </div>
      </section>
    `;
  }

  function homeStyles() {
    return `<style>
      .home-kicker{margin:0;color:var(--gold-deep);font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}
      .home-welcome{display:grid;grid-template-columns:132px minmax(0,1fr);gap:26px;align-items:center;padding:30px;border:1px solid var(--line);border-radius:26px;background:linear-gradient(135deg,rgba(255,253,248,.94),rgba(239,228,209,.76));box-shadow:0 12px 32px rgba(76,51,22,.08);position:relative;overflow:hidden}
      .home-welcome::after{content:"";position:absolute;width:280px;height:280px;right:-130px;top:-140px;border-radius:50%;background:color-mix(in srgb,var(--local-accent) 11%,transparent);pointer-events:none}.home-welcome>*{position:relative;z-index:1}
      .home-welcome-logo{display:grid;place-items:center}.home-team-logo{width:118px;height:118px}.home-welcome h3{margin:6px 0 9px;font-size:clamp(30px,4vw,44px);letter-spacing:-.035em}.home-welcome-copy>p:not(.home-kicker){max-width:650px;margin:0;font-size:16px;line-height:1.55;font-weight:580}
      .home-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:15px;color:var(--muted);font-size:13px;font-weight:700}.home-meta span+span{position:relative}.home-meta span+span::before{content:"·";position:absolute;left:-11px}
      .home-primary-action{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:18px;align-items:center;margin-top:14px;padding:21px 22px;border:1px solid rgba(183,137,69,.34);border-radius:22px;background:rgba(255,253,248,.84);box-shadow:0 9px 25px rgba(76,51,22,.06)}
      .home-primary-icon{width:52px;height:52px;display:grid;place-items:center;border-radius:50%;background:rgba(201,170,114,.16);color:var(--ink);font-size:24px;font-weight:900}.home-primary-copy small{color:var(--gold-deep);font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.home-primary-copy h3{margin:3px 0 4px;font-size:23px;letter-spacing:-.02em}.home-primary-copy p{margin:0;max-width:690px;font-size:14px;line-height:1.48}.home-primary-action button{min-height:48px;white-space:nowrap}
      .home-primary-action--today{border-color:rgba(122,49,64,.36)}.home-primary-action--today .home-primary-icon{background:rgba(122,49,64,.11);color:#7a3140}.home-primary-action--play{border-color:color-mix(in srgb,var(--team-accent) 35%,var(--line))}
      .home-essential{margin-top:32px;scroll-margin-top:90px}.home-section-heading{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:13px}.home-section-heading h3{margin:5px 0 0;font-size:clamp(28px,3.5vw,38px);letter-spacing:-.03em}.home-calendar-link{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 15px;border:1px solid var(--line);border-radius:999px;background:rgba(255,253,248,.70);color:var(--ink);font-size:13px;font-weight:850;text-decoration:none}
      .home-essential-card{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:22px;background:rgba(255,253,248,.78);overflow:hidden;box-shadow:0 8px 24px rgba(76,51,22,.05)}.home-essential-row{display:grid;grid-template-columns:44px 1fr;gap:13px;align-items:start;padding:20px}.home-essential-row:nth-child(odd){border-right:1px solid var(--line)}.home-essential-row:nth-child(-n+2){border-bottom:1px solid var(--line)}
      .home-essential-icon{width:42px;height:42px;display:grid;place-items:center;border:1px solid rgba(201,170,114,.30);border-radius:13px;background:rgba(201,170,114,.10);color:var(--ink);font-size:20px;font-weight:850}.home-essential-row small{display:block;color:var(--gold-deep);font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.home-essential-row strong{display:block;margin-top:4px;color:var(--ink);font-family:var(--font-title);font-size:17px;line-height:1.25}.home-essential-row p{margin:4px 0 0;font-size:13px;line-height:1.42}
      .home-details{margin-top:10px;border:1px solid var(--line);border-radius:17px;background:rgba(255,253,248,.58);overflow:hidden}.home-details summary{min-height:50px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 17px;cursor:pointer;color:var(--ink);font-size:14px;font-weight:850;list-style:none}.home-details summary::-webkit-details-marker{display:none}.home-details summary i{font-style:normal;font-size:19px;transition:transform .18s ease}.home-details[open] summary i{transform:rotate(180deg)}.home-details-content{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0 15px 15px}.home-details-content article{padding:14px;border-radius:14px;background:rgba(255,255,255,.46)}.home-details-content strong{color:var(--ink);font-size:14px}.home-details-content p{margin:5px 0 0;font-size:13px;line-height:1.45}
      .home-team-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:22px;align-items:center;margin-top:30px;padding:22px;border:1px solid color-mix(in srgb,var(--local-accent) 25%,var(--line));border-radius:23px;background:linear-gradient(135deg,rgba(255,253,248,.88),rgba(239,228,209,.72))}.home-team-identity{display:flex;align-items:center;gap:15px;min-width:0}.home-team-card-logo{width:68px;height:68px;flex:0 0 auto}.home-team-identity small{display:block;color:var(--gold-deep);font-size:10px;font-weight:900;letter-spacing:.11em;text-transform:uppercase}.home-team-identity h3{margin:3px 0 2px;font-size:25px}.home-team-identity p{margin:0;font-size:12px;line-height:1.35}
      .home-team-score{display:grid;grid-template-columns:repeat(2,72px);text-align:center}.home-team-score span{display:grid;gap:2px}.home-team-score span+span{border-left:1px solid var(--line)}.home-team-score b{color:var(--ink);font-family:var(--font-title);font-size:22px}.home-team-score small{color:var(--muted-2);font-size:9px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}.home-team-actions{display:flex;gap:8px}.home-team-actions button{min-height:46px;white-space:nowrap}
      @media(max-width:900px){.home-team-card{grid-template-columns:minmax(0,1fr) auto}.home-team-actions{grid-column:1/-1}.home-team-actions button{flex:1}.home-primary-action{grid-template-columns:52px 1fr}.home-primary-action button{grid-column:1/-1;width:100%}}
      @media(max-width:680px){.home-welcome{grid-template-columns:84px 1fr;gap:16px;padding:22px 18px}.home-team-logo{width:82px;height:82px}.home-welcome h3{font-size:29px}.home-welcome-copy>p:not(.home-kicker){font-size:15px}.home-meta{display:grid;gap:3px;margin-top:11px}.home-meta span+span::before{display:none}.home-primary-action{grid-template-columns:44px 1fr;gap:13px;padding:18px 16px}.home-primary-icon{width:44px;height:44px}.home-primary-copy h3{font-size:21px}.home-primary-copy p{font-size:14px}.home-section-heading{align-items:center}.home-calendar-link{padding:9px 12px}.home-essential-card{grid-template-columns:1fr}.home-essential-row{padding:17px 16px}.home-essential-row:nth-child(n){border-right:0}.home-essential-row:not(:last-child){border-bottom:1px solid var(--line)}.home-details-content{grid-template-columns:1fr}.home-team-card{grid-template-columns:1fr;padding:18px}.home-team-score{grid-template-columns:repeat(2,1fr);padding:13px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.home-team-actions{grid-column:auto}.home-team-actions button{width:100%}}
      @media(max-width:430px){.home-welcome{grid-template-columns:1fr;text-align:center}.home-welcome-logo{margin-bottom:-4px}.home-team-logo{width:72px;height:72px}.home-meta{justify-items:center}.home-section-heading h3{font-size:30px}.home-calendar-link span{display:inline}.home-team-identity{justify-content:center;text-align:left}.home-team-actions{display:grid}.home-primary-action button,.home-team-actions button{min-height:50px}}

      .home-countdown{min-height:64px;display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:12px;padding:10px 18px;border:1px solid rgba(122,49,64,.18);border-radius:18px;background:rgba(255,253,248,.72);box-shadow:0 6px 18px rgba(76,51,22,.04)}
      .home-countdown-label{color:#7a3140;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.home-countdown-values{display:flex;align-items:center;gap:9px}.home-countdown-values>span{display:grid;justify-items:center;min-width:44px}.home-countdown-values strong{color:var(--ink);font-family:var(--font-title);font-size:21px;line-height:1}.home-countdown-values small{margin-top:3px;color:var(--muted-2);font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.home-countdown-values i{color:rgba(122,49,64,.44);font-style:normal;font-weight:900}.home-countdown-date{color:var(--muted-2);font-size:10px;font-weight:750}
      .home-welcome{grid-template-columns:86px minmax(0,1fr);gap:18px;padding:18px 22px;border-radius:21px}.home-team-logo{width:76px;height:76px}.home-welcome h3{margin:4px 0 5px;font-size:clamp(24px,3vw,31px)}.home-welcome-copy>p:not(.home-kicker){font-size:14px;line-height:1.42}.home-meta{margin-top:10px}
      .home-rsvp-confirmed{width:max-content;max-width:100%;min-height:38px;display:inline-flex;align-items:center;gap:8px;margin:10px 0 0;padding:8px 13px;border:1px solid rgba(74,125,79,.28);border-radius:999px;background:rgba(74,125,79,.09);color:#426f47;font-size:13px;font-weight:850;box-shadow:none}.home-rsvp-confirmed .ui-icon{width:18px;height:18px}
      @media(max-width:680px){.home-countdown{gap:10px;padding:9px 12px}.home-countdown-date{display:none}.home-welcome{grid-template-columns:70px minmax(0,1fr);gap:14px;padding:16px}.home-team-logo{width:64px;height:64px}.home-welcome h3{font-size:23px}.home-welcome-copy>p:not(.home-kicker){font-size:13px}.home-meta{font-size:12px}.home-rsvp-confirmed{display:flex;width:100%;justify-content:center}}
      @media(max-width:430px){.home-countdown{justify-content:space-between}.home-countdown-values{gap:6px}.home-countdown-values>span{min-width:38px}.home-countdown-values strong{font-size:19px}.home-welcome{grid-template-columns:64px minmax(0,1fr);text-align:left}.home-welcome-logo{margin:0}.home-team-logo{width:58px;height:58px}.home-meta{justify-items:start}}
    </style>`;
  }

  function statCard(label, value, icon) {
    return `<article class="stat-card"><span>${icon}</span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></article>`;
  }

  function renderInfo() {
    const locationOpen = isUnlocked("location");
    const menuOpen = isUnlocked("menu");
    const calendarUrl = "https://www.google.com/calendar/event?eid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&ctz=America/Argentina/Buenos_Aires";

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
    const calendarUrl = "https://www.google.com/calendar/event?eid=NWNiZ2Fzb2Rxb2E2c3VxcTZ1cmJqMm9sMmsgZmVkZXJpY29zYW50aTkxQG0&ctz=America/Argentina/Buenos_Aires";
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
      .calendar-strip{display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid rgba(122,49,64,.18);border-radius:22px;padding:18px 20px;margin:0 0 20px;background:linear-gradient(135deg,rgba(255,253,248,.94),rgba(239,228,209,.78));box-shadow:0 8px 22px rgba(76,51,22,.05)}
      .calendar-strip strong{display:block;color:#7a3140;font-weight:950;letter-spacing:.05em}.calendar-strip p{margin:4px 0 0;color:var(--muted);font-weight:650}
      .calendar-strip a,.rsvp-calendar-link{display:inline-flex;align-items:center;justify-content:center;min-height:46px;text-decoration:none;border-radius:999px;border:1px solid #6f2f3f;padding:12px 18px;background:#743344;color:#fffaf0!important;font-weight:900;white-space:nowrap;box-shadow:0 7px 16px rgba(116,51,68,.14)}
      .calendar-strip a:hover,.rsvp-calendar-link:hover{background:#652c3b;color:#fff!important}
      .choice-field{border:0;padding:0;margin:0}.choice-field legend{color:var(--ink);font-weight:900;margin:0 0 10px}
      .choice-group{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.choice-pill{cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center;min-height:54px;border-radius:999px;border:1px solid rgba(132,104,68,.22);background:rgba(255,255,255,.55);color:var(--ink);font-weight:900;text-align:center;padding:14px 12px;transition:.18s ease}.choice-pill input{position:absolute;opacity:0;pointer-events:none}.choice-pill:has(input:checked){background:#743344;color:#fffaf0;border-color:#743344;box-shadow:0 0 0 3px rgba(116,51,68,.12)}
      .rsvp-thank-card{padding:28px;background:linear-gradient(180deg,rgba(255,253,248,.94),rgba(239,228,209,.84))}.rsvp-thank-grid{display:grid;grid-template-columns:1.35fr .65fr;gap:24px;align-items:stretch}
      .rsvp-okmark{width:68px;height:68px;border-radius:50%;display:grid;place-items:center;background:rgba(74,125,79,.10);border:1px solid rgba(74,125,79,.28);color:#426f47;font-size:34px;font-weight:1000;margin-bottom:16px}
      .rsvp-thank-title{font-family:var(--font-title);font-size:clamp(28px,4vw,40px);line-height:1.05;margin:0 0 10px;color:var(--ink)}.rsvp-thank-lead{color:var(--muted);font-weight:650;font-size:16px;line-height:1.5;max-width:760px}
      .rsvp-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:22px}.rsvp-summary-grid .wide{grid-column:1/-1}.summary-item{border:1px solid rgba(132,104,68,.16);border-radius:16px;padding:15px;background:rgba(255,255,255,.48)}.summary-item strong{display:block;color:#7a3140;font-size:11px;text-transform:uppercase;letter-spacing:.09em;margin-bottom:6px}.summary-item p{margin:0;color:var(--ink);font-weight:750;word-break:break-word}
      .rsvp-side-note{border:1px solid rgba(132,104,68,.17);border-radius:21px;padding:21px;background:rgba(255,255,255,.38)}.rsvp-side-note h4{font-family:var(--font-title);color:var(--ink);font-size:23px;margin:0 0 10px}.rsvp-side-note p{color:var(--muted);font-weight:650;line-height:1.5}
      .rsvp-actions-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.rsvp-actions-row .ghost-button{background:rgba(255,255,255,.56);color:var(--ink);border-color:rgba(132,104,68,.22)}
      @media(max-width:850px){.calendar-strip{align-items:flex-start;flex-direction:column}.calendar-strip a{width:100%}.choice-group{grid-template-columns:1fr}.rsvp-thank-grid{grid-template-columns:1fr}.rsvp-summary-grid{grid-template-columns:1fr}.rsvp-calendar-link{width:100%}.rsvp-actions-row>button{width:100%}}
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
    const selectedTeamId = selectedTeamViewId || currentGuest.team;
    const team = getTeam(selectedTeamId);
    const members = DATA.guests.filter(guest => guest.team === team.id).sort(sortGuestsForDisplay);
    const activePlayers = teamCompetitionMembers(team.id).length;
    const confirmed = completedRsvpMembers(team.id).length;
    return `
      ${captainGuestStyles()}
      ${sectionHeader("mi fuerza", `Equipo ${team.name}`, `${team.group}. Capitán: ${team.captain}.`)}
      <section class="team-hero section-card" style="--local-accent:${team.accent}">
        <div class="team-symbol">${teamLogo(team, "team-symbol-logo")}</div>
        <div>
          <h3>${team.name}</h3>
          <p>${escapeHTML(team.motto)}</p>
          <div class="badge-row">
            <span class="badge">${escapeHTML(team.colorName)}</span>
            <span class="badge muted">${escapeHTML(team.trait)}</span>
            <span class="badge muted">Jugadores activos: ${activePlayers}</span>
          </div>
          <div class="team-page-actions">
            <button type="button" data-go="ranking">${uiIcon("ranking")}<span>Ver ranking</span></button>
          </div>
        </div>
      </section>
      <section class="grid two">
        <article class="section-card"><h4>Formación</h4><p class="form-note">Capitán primero. Fede y Vani no cuentan para los puntos competitivos.</p><div class="guest-list">${members.map(guestPill).join("")}</div></article>
        <article class="section-card team-attendance-card"><span class="team-attendance-icon">${uiIcon("calendar")}</span><div><h4>Asistencia</h4><p><strong>${confirmed} de ${activePlayers}</strong> integrantes ya confirmaron.</p><div class="team-attendance-progress" role="progressbar" aria-label="Asistencia confirmada del equipo" aria-valuemin="0" aria-valuemax="${activePlayers}" aria-valuenow="${confirmed}"><span style="width:${Math.min(100, Math.round((confirmed / Math.max(activePlayers, 1)) * 100))}%"></span></div><small>El estado se actualiza cuando cada integrante completa su confirmación.</small></div></article>
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
          <p>Vas a competir contra otros 5 equipos desde ahora hasta que finalice la fiesta. Cada acción completada suma para tu equipo.</p>
          <div class="badge-row">${teamBadge(team, team.name)}<span class="badge muted">Capitán: ${escapeHTML(team.captain)}</span><span class="badge muted">Jugadores activos: ${activePlayers}</span><span class="badge muted">Puntos actuales: ${myPoints}</span></div>
        </div>
        <div class="points-medal"><span>🏆</span><strong>${myPoints}</strong><small>puntos actuales</small></div>
      </section>

      <section class="grid two points-rules">
        <article class="section-card"><span class="card-icon">👥</span><h4>Jugadores activos</h4><p>Fede y Vani no cuentan para el cálculo competitivo. El puntaje se calcula sobre los invitados jugadores de cada equipo.</p></article>
        <article class="section-card"><span class="card-icon">🎉</span><h4>Hasta el final</h4><p>Los puntos se acumulan desde ahora y siguen durante la fiesta con juegos físicos, bonus y sorpresas.</p></article>
      </section>

      <section class="section-card">
        <div class="card-title-row"><h4>Qué podés hacer ahora</h4><span class="badge">Primera tanda</span></div>
        ${pointsAction("✉️", "Confirmar asistencia antes del 31/08", currentGuestCanScore ? (rsvpDone ? `Ya sumaste puntos para ${team.name}. Podés editar tu respuesta, pero no suma dos veces.` : `Al completar esta acción sumás puntos para ${team.name}. También elegís traslado y cargás restricciones alimenticias.`) : "Los novios no suman puntos, pero pueden revisar el estado del equipo.", "Suma puntos", rsvpDone, "asistencia", `${rsvpDoneCount} de ${activePlayers} confirmaron`)}
        ${pointsAction("🎵", "Proponer canción de equipo", "Próximamente cada equipo podrá proponer un tema que represente a su fuerza.", "Próximamente", false, "equipo", "Consigna de equipo")}
        ${pointsAction("❓", "Trivia Vani y Fede", "Próximamente: ¿Qué tanto sabés de los novios? Animate a contestar y sumar puntos para tu equipo.", "Próximamente", false, "", "Juego individual")}
        ${pointsAction("⚔️", "Desafío sorpresa", "Se habilitarán consignas nuevas hasta el día de la fiesta.", "Próximamente", false, "equipo", "Candado activo")}
      </section>

      <section class="section-card points-note"><span class="card-icon">⚔️</span><h4>Importante</h4><p>Editar una respuesta no vuelve a sumar puntos. Los puntos de asistencia se calculan una sola vez por jugador activo.</p></section>
    `;
  }

  function pointsAction(icon, title, text, points, done, route, progressText = "") {
    const action = route
      ? `<button type="button" data-go="${escapeHTML(route === "equipo" ? "equipo" : route)}">${done ? "Ver / editar" : route === "asistencia" ? "Hacer" : "Ver"}</button>`
      : `<button type="button" disabled aria-disabled="true">Próximamente</button>`;
    return `<article class="points-action ${done ? "done" : ""}"><div class="points-left"><span>${icon}</span><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p>${progressText ? `<small class="points-progress">${escapeHTML(progressText)}</small>` : ""}${done ? `<small class="points-done-note">✅ Ya sumaste estos puntos</small>` : ""}</div></div><div class="points-right"><b>${escapeHTML(points)}</b>${action}</div></article>`;
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
      <section class="ranking-action-card section-card">
        <div>
          <strong>¿Querés ayudar a tu equipo?</strong>
          <p>Revisá las acciones disponibles y sumá puntos.</p>
        </div>
        <button type="button" data-go="puntos">${uiIcon("play")}<span>Sumá puntos</span></button>
      </section>
      <section class="ranking-list">${ranking.map(rankRow).join("")}</section>
      <section class="section-card"><h4>Últimos movimientos</h4>${allPointEntries().length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Equipo</th><th>Movimiento</th><th>Comentario</th></tr></thead><tbody>${allPointEntries().slice(-12).reverse().map(entry => `<tr><td>${formatDateLabel(entry.timestamp || entry.submittedAt || entry.updatedAt)}</td><td>${escapeHTML(gameName(entry.gameId))}</td><td>${escapeHTML(getTeam(entry.teamId).name)}</td><td>Sumó puntos</td><td>${escapeHTML(entry.comment || "El equipo sumó puntos.")}</td></tr>`).join("")}</tbody></table></div>` : `<p>Todavía no hay movimientos cargados.</p>`}</section>`;
  }

  function rankRow(row, index) {
    const team = getTeam(row.id);
    const pos = index + 1;
    const ownTeam = currentGuest?.team === team.id;
    return `<button type="button" class="rank-item rank-item-button ${ownTeam ? "is-my-team" : ""}" data-team-open="${team.id}" style="--local-accent:${team.accent}" aria-label="Abrir equipo ${escapeHTML(team.name)}"><span class="rank-pos">${pos}</span><span class="rank-emoji">${teamLogo(team, "rank-team-logo")}</span><div><strong>${escapeHTML(team.name)}</strong><small>${escapeHTML(team.group)}${ownTeam ? " · Tu equipo" : ""}</small></div><div class="rank-points"><strong>${row.total}</strong><small>puntos</small></div></button>`;
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
        ${sectionHeader("admin", "Panel de control", "Revisá la asistencia y gestioná puntos de forma simple.")}
        <form id="adminLoginForm" class="section-card form-card narrow">
          <label>Clave admin<input name="password" type="password" placeholder="Clave"></label>
          <button type="submit">Entrar al panel</button>
        </form>`;
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

    return `
      ${adminUxStyles()}
      ${sectionHeader("admin", "Centro de mando", "Asistencia general y ajustes rápidos del ranking.")}

      <section class="admin-attendance-summary">
        <article>
          <span>✓</span>
          <div><small>Confirmaron asistencia</small><strong>${attendingCount}</strong><p>de ${invitedCount} invitados</p></div>
        </article>
        <article>
          <span>%</span>
          <div><small>Porcentaje confirmado</small><strong>${attendancePercent}%</strong><p>sobre el total invitado</p></div>
        </article>
        <article>
          <span>−</span>
          <div><small>No asistirán</small><strong>${declinedCount}</strong><p>respuestas registradas</p></div>
        </article>
        <article>
          <span>?</span>
          <div><small>Sin responder</small><strong>${unansweredCount}</strong><p>faltan completar RSVP</p></div>
        </article>
      </section>

      <form id="scoreForm" class="section-card admin-score-card">
        <div class="admin-score-heading">
          <div>
            <p class="eyebrow">Ajuste discrecional</p>
            <h4>Sumar o restar puntos</h4>
            <p>Elegí el equipo, el tipo de movimiento y la cantidad.</p>
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

      ${resetButtonStyles()}
      <section class="section-card admin-reset-panel">
        <h4>Reseteo de puntos</h4>
        <p>Usalo únicamente cuando necesites volver atrás. No borra asistencias ni invitados.</p>
        <div class="admin-reset-actions">
          <button id="resetDiscretionaryPoints" type="button" class="danger-button">Resetear discrecionales</button>
          <button id="resetAllPoints" type="button" class="danger-button">Resetear todo el ranking</button>
        </div>
      </section>`;
  }

  function adminUxStyles() {
    return `<style>
      .admin-attendance-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .admin-attendance-summary article{display:grid;grid-template-columns:46px minmax(0,1fr);gap:12px;align-items:center;padding:18px;border:1px solid var(--line);border-radius:20px;background:rgba(255,253,248,.78);box-shadow:0 8px 20px rgba(76,51,22,.05)}
      .admin-attendance-summary article>span{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:rgba(122,49,64,.09);color:#743344;font-size:20px;font-weight:950}
      .admin-attendance-summary small{display:block;color:var(--muted-2);font-weight:850}.admin-attendance-summary strong{display:block;margin-top:2px;color:var(--ink);font-family:var(--font-title);font-size:29px}.admin-attendance-summary p{margin:1px 0 0;font-size:12px;line-height:1.35}
      .admin-score-card{display:grid;gap:22px;margin-top:16px;padding:26px}.admin-score-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.admin-score-heading h4{margin:5px 0 6px;font-size:28px}.admin-score-heading p{margin:0}.admin-score-preview{display:inline-flex;align-items:center;min-height:36px;padding:8px 12px;border-radius:999px;background:rgba(201,170,114,.13);color:var(--gold-deep);font-size:12px;font-weight:900;white-space:nowrap}
      .admin-score-fieldset{margin:0;padding:0;border:0}.admin-score-fieldset legend{margin-bottom:11px;color:var(--ink);font-weight:900}.admin-team-picker{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.admin-team-option{position:relative;display:grid;justify-items:center;gap:7px;min-height:104px;margin:0;padding:13px 8px;border:1px solid var(--line);border-radius:17px;background:rgba(255,255,255,.40);color:var(--ink);font-size:12px;font-weight:900;cursor:pointer;text-align:center}.admin-team-option input{position:absolute;opacity:0;pointer-events:none}.admin-team-option:has(input:checked){border-color:color-mix(in srgb,var(--local-accent) 65%,var(--line));background:color-mix(in srgb,var(--local-accent) 13%,rgba(255,255,255,.56));box-shadow:0 0 0 3px color-mix(in srgb,var(--local-accent) 12%,transparent)}.admin-team-logo{width:48px;height:48px}
      .admin-sign-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.admin-sign-picker label{position:relative;margin:0}.admin-sign-picker input{position:absolute;opacity:0;pointer-events:none}.admin-sign-picker span{display:flex;align-items:center;justify-content:center;min-height:49px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.42);color:var(--ink);font-weight:900;cursor:pointer}.admin-sign-picker label:first-child:has(input:checked) span{border-color:rgba(74,125,79,.35);background:rgba(74,125,79,.10);color:#426f47}.admin-sign-picker label:last-child:has(input:checked) span{border-color:rgba(185,87,77,.34);background:rgba(185,87,77,.09);color:#93463c}
      .admin-points-input{position:relative}.admin-points-input input{height:58px;margin:0;padding-right:80px;border-radius:15px;font-size:21px;font-weight:850}.admin-points-input>span{position:absolute;right:17px;top:50%;transform:translateY(-50%);color:var(--muted-2);font-size:13px;font-weight:850}.admin-preset-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.admin-preset-row button{min-width:64px;padding:9px 13px;border:1px solid var(--line);background:rgba(255,255,255,.45);color:var(--ink);box-shadow:none}.admin-comment-label{margin:0}.admin-comment-label>span{color:var(--muted-2);font-weight:600}.admin-comment-label textarea{min-height:85px}
      .admin-score-submit{width:100%;min-height:52px}.admin-score-submit.is-negative{background:linear-gradient(135deg,#c66b5d,#9d4138);color:#fff}.admin-score-submit:disabled{cursor:not-allowed;opacity:.48;transform:none}
      .team-page-actions{display:flex;gap:9px;margin-top:17px}.team-page-actions button,.ranking-action-card button{display:inline-flex;align-items:center;gap:8px}.team-page-actions .ui-icon,.ranking-action-card .ui-icon{width:19px;height:19px}
      .ranking-action-card{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 20px}.ranking-action-card strong{color:var(--ink);font-size:17px}.ranking-action-card p{margin:3px 0 0;font-size:13px}.ranking-action-card button{white-space:nowrap}
      @media(max-width:900px){.admin-attendance-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.admin-team-picker{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:560px){.admin-attendance-summary{grid-template-columns:1fr 1fr}.admin-attendance-summary article{grid-template-columns:1fr;gap:7px;padding:14px}.admin-attendance-summary article>span{width:36px;height:36px}.admin-attendance-summary strong{font-size:25px}.admin-score-card{padding:18px}.admin-score-heading{display:grid}.admin-score-preview{width:max-content}.admin-team-picker{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-action-card{align-items:flex-start;flex-direction:column}.ranking-action-card button,.team-page-actions button{width:100%;justify-content:center}}
    </style>`;
  }

  function bindViewEvents(route) {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (route === "inicio") startHomeCountdown();

    $$('[data-team-open]').forEach(button => button.addEventListener("click", () => {
      selectedTeamViewId = button.dataset.teamOpen;
      navigate("equipo");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));

    $$('[data-go]').forEach(button => button.addEventListener("click", () => {
      if (button.dataset.go === "equipo") selectedTeamViewId = currentGuest?.team || null;
      navigate(button.dataset.go);
    }));
    $$('[data-scroll]').forEach(button => button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.scroll);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));

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

    scoreForm?.addEventListener("submit", event => {
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

      state.scoreEntries.push(payload);
      state.scoreEntries = dedupeScores(state.scoreEntries);
      saveState();
      toast(`${sign < 0 ? "Se restaron" : "Se sumaron"} ${amount} puntos a ${getTeam(teamId).name}.`);
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
