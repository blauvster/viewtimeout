class ViewTimeout {
  constructor() {
    this.timer = null;
    this.checkInterval = null;
    this.boundReset = this.resetTimer.bind(this);

    // Global fallback config — used on any dashboard that doesn't
    // define its own `view_timeout:` block in its YAML.
    // Set by adding a `view_timeout_global:` block (same shape as
    // `view_timeout:`) to ANY one dashboard's YAML. The first time
    // that dashboard is visited in this browser session, its
    // view_timeout_global block is cached here and used as the
    // fallback for every other dashboard from then on. No hardcoded
    // values — until a dashboard with that tag has been visited,
    // this stays null and dashboards without their own view_timeout
    // block stay dormant.
    this.globalConfig = null;

    // State
    this.activePanelUrl = null; // The dashboard we are currently "serving"
    this.currentUser = null;
    this.homeView = "home";
    this.timeoutDuration = 15000;
    this.viewSpecificRedirects = {};
    this.isEnabled = false;

    // Reset triggers
    this.resetOnMove = false;
    this.resetOnClick = true;

    // Start the global watcher
    this.init();
  }

  get ha() {
    return document.querySelector("home-assistant");
  }

  get main() {
    return this.ha?.shadowRoot?.querySelector("home-assistant-main")?.shadowRoot;
  }

  get lovelace() {
    // This dynamically grabs the CURRENT lovelace panel
    return this.main?.querySelector("ha-panel-lovelace");
  }

  log(msg, error = false) {
    const style = "color: orange; font-weight: bold; background: black; padding: 2px;";
    if (error) {
      console.error(`%c VIEWTIMEOUT %c ERROR: ${msg}`, style, "color: red;");
    } else {
      console.info(`%c VIEWTIMEOUT %c ${msg}`, style, "color: gray;");
    }
  }

  init() {
    // We check every second. This interval runs forever, across all dashboards.
    this.checkInterval = setInterval(() => this.masterLoop(), 1000);
    this.log("Service started. Waiting for config...");
  }

  // This loop runs every second to check:
  // 1. Did we change dashboards?
  // 2. If yes, load new config.
  // 3. If no, run the timeout logic.
  masterLoop() {
    if (new URLSearchParams(window.location.search).has("disable_timeout")) return;

    const currentPanelUrl = this.ha?.hass?.panelUrl;

    // SCENARIO 1: Dashboard Change Detected
    if (currentPanelUrl !== this.activePanelUrl) {
      this.handleDashboardChange(currentPanelUrl);
      return;
    }

    // SCENARIO 2: We are on the active dashboard, and it is enabled.
    if (this.isEnabled) {
      this.checkTimeoutLogic();
    }
  }

  handleDashboardChange(newPanelUrl) {
    // 1. Stop any running timers from the previous dashboard
    this.stopTimer();

    // 2. Try to find config for this new dashboard
    // It might take a moment for the new ha-panel-lovelace to load its config
    const llConfig = this.lovelace?.lovelace?.config;

    // Config hasn't loaded yet — wait and retry next loop.
    if (!llConfig) return;

    this.activePanelUrl = newPanelUrl;

    // If this dashboard carries a view_timeout_global block, cache it
    // (refreshing the cache each visit) so any other dashboard without
    // its own view_timeout block can fall back to it.
    if (llConfig.view_timeout_global) {
      this.globalConfig = llConfig.view_timeout_global;
      this.log(`Global config cached from /${this.activePanelUrl}`);
    }

    // Use this dashboard's own config if it defines one, otherwise
    // fall back to the cached global config (if any has been seen
    // yet this session).
    const config = llConfig.view_timeout ?? this.globalConfig;
    this.parseConfig({ view_timeout: config });
  }

  parseConfig(llConfig) {
    // Neither this dashboard's own view_timeout nor a cached global
    // config exists — stay dormant rather than activating with
    // fallback defaults.
    if (!llConfig.view_timeout) {
      this.isEnabled = false;
      return;
    }

    const config = llConfig.view_timeout;

    // Global Toggle Check
    if (config.timeout === false) {
      this.isEnabled = false;
      return;
    }

    // User Whitelist Check
    this.currentUser = this.ha?.hass?.user?.name?.toLowerCase();
    if (config.users && Array.isArray(config.users)) {
      const allowedUsers = config.users.map((u) => u.toLowerCase());
      if (!allowedUsers.includes(this.currentUser)) {
        this.isEnabled = false;
        return;
      }
    }

    // Load Settings
    this.timeoutDuration = config.duration ?? 15000;
    this.homeView = config.default ?? "home";
    this.resetOnMove = config.reset?.mouse_move ?? false;
    this.resetOnClick = config.reset?.mouse_click ?? true;
    this.viewSpecificRedirects = config.views || {};

    // Activate
    this.isEnabled = true;
    this.log(`Active on /${this.activePanelUrl} (Timeout: ${this.timeoutDuration}ms)`);
  }

  getCurrentView() {
    return window.location.pathname.split("/").pop();
  }

  checkTimeoutLogic() {
    // Safety: If we drifted somehow, stop.
    if (this.ha?.hass?.panelUrl !== this.activePanelUrl) return;

    const currentView = this.getCurrentView();

    // 1. Is this the default home view?
    if (currentView === this.homeView) {
      this.stopTimer();
      return;
    }

    // 2. Is this view explicitly disabled?
    const specificTarget = this.viewSpecificRedirects[currentView];
    if (specificTarget === false) {
      this.stopTimer();
      return;
    }

    // 3. If no default home and no specific target, do nothing.
    if (!this.homeView && !specificTarget) {
      this.stopTimer();
      return;
    }

    // Run timer if not already running
    if (!this.timer) {
      this.startTimer();
    }
  }

  startTimer() {
    // Re-bind listeners (idempotent, safe to call multiple times due to boundReset)
    if (this.resetOnMove) window.addEventListener("mousemove", this.boundReset);
    if (this.resetOnClick) window.addEventListener("click", this.boundReset);
    this.resetTimer();
  }

  stopTimer() {
    window.removeEventListener("mousemove", this.boundReset);
    window.removeEventListener("click", this.boundReset);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resetTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.executeRedirect(), this.timeoutDuration);
  }

  executeRedirect() {
    // Double check we are still on the right dashboard
    if (this.ha?.hass?.panelUrl !== this.activePanelUrl) {
      this.stopTimer();
      return;
    }

    this.stopTimer();

    try {
      const activeEl = this.main?.activeElement || document.activeElement;
      activeEl?.blur();
    } catch (e) {}

    const currentView = this.getCurrentView();
    const target = this.viewSpecificRedirects[currentView] ?? this.homeView;

    if (target) {
      // target is always treated as a full path from the site root —
      // never prefixed with activePanelUrl. Use a leading "/" or not,
      // both work the same.
      const path = target.startsWith("/") ? target : `/${target}`;
      this.navigate(path);
    }
  }

  navigate(path) {
    window.history.pushState(null, "", path);
    window.dispatchEvent(
      new CustomEvent("location-changed", {
        bubbles: true,
        composed: true,
      })
    );
  }
}

Promise.resolve(customElements.whenDefined("hui-view")).then(() => {
  if (!window.ViewTimeout) {
    window.ViewTimeout = new ViewTimeout();
  }
});
