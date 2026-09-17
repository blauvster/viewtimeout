/*
 * Modified from BWilky/viewtimeout (timeout.js). Changes:
 *
 * 1. Absolute redirect targets — `default` / per-view targets in
 *    `views:` are now treated as full paths (e.g. "dashboard-kiosk/0"),
 *    not a view name within the current dashboard. The original
 *    always prefixed the target with the current dashboard's
 *    panelUrl, which made cross-dashboard redirects impossible.
 *
 * 2. Global config via `view_timeout_global:` — add this block
 *    (same shape as `view_timeout:`) to any one dashboard's YAML to
 *    define a fallback config for every other dashboard. It's
 *    cached in memory the first time that dashboard is visited in
 *    the browser session (handleDashboardChange), and any dashboard
 *    without its own `view_timeout:` block uses the cached value.
 *    A dashboard's own `view_timeout:` block still takes priority
 *    over the cache when present.
 *
 * 3. No hardcoded fallback values — if a dashboard has neither its
 *    own `view_timeout:` nor a cached global config, the script
 *    stays fully dormant (isEnabled = false) instead of activating
 *    with baked-in defaults.
 */
class ViewTimeout {
  constructor() {
    this.timer = null;
    this.checkInterval = null;
    this.boundReset = this.resetTimer.bind(this);

    // Global fallback config — used on any dashboard that doesn't
    // define its own `view_timeout:` block in its YAML.
    // Set by adding a `view_timeout_global:` block (same shape as
    // `view_timeout:`) to ANY one dashboard's YAML. The first time
    // that dashboard is visited, its view_timeout_global block is
    // cached here AND persisted to localStorage, so it survives page
    // reloads without needing to revisit that dashboard first. No
    // hardcoded values — until a dashboard with that tag has been
    // visited at least once (ever, on this browser), this stays null
    // and dashboards without their own view_timeout block stay
    // dormant.
    this.globalConfigStorageKey = "viewtimeout_global_config";
    this.globalConfig = this.loadCachedGlobalConfig();

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

  // Reads any previously-cached global config from localStorage so
  // it's available immediately on load, before this browser has
  // necessarily (re)visited the dashboard carrying view_timeout_global
  // in this page load. Returns null if nothing is stored or it can't
  // be read (e.g. storage disabled/blocked).
  loadCachedGlobalConfig() {
    try {
      const raw = localStorage.getItem(this.globalConfigStorageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      this.log(`Could not read cached global config from localStorage: ${e}`, true);
      return null;
    }
  }

  // Persists the global config to localStorage whenever it's
  // (re)discovered from a dashboard's view_timeout_global block, so
  // it survives page reloads.
  saveCachedGlobalConfig(config) {
    try {
      localStorage.setItem(this.globalConfigStorageKey, JSON.stringify(config));
    } catch (e) {
      this.log(`Could not save global config to localStorage: ${e}`, true);
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
    // in memory and persist it to localStorage (refreshing both each
    // visit) so any other dashboard without its own view_timeout
    // block can fall back to it — even after a page reload.
    if (llConfig.view_timeout_global) {
      this.globalConfig = llConfig.view_timeout_global;
      this.saveCachedGlobalConfig(this.globalConfig);
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
