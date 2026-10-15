import type { Browser, BrowserType, LaunchOptions } from '@playwright/test';

/** The engines the browser suite runs (one Playwright project each). */
export type EngineName = 'chromium' | 'firefox' | 'webkit';

/**
 * Per-engine launch options for REAL media playback in the harness.
 *
 * Each engine needs its own accommodation so media never depends on a user
 * gesture during tests:
 * - chromium: the `--autoplay-policy` command-line flag.
 * - firefox: autoplay is governed by about:config prefs, not command-line
 *   flags — `media.autoplay.default: 0` allows all autoplay and
 *   `media.autoplay.enabled.user-gestures-needed: false` stops gesture
 *   activation from overriding the default.
 * - webkit: no options needed — muted play() is not gesture-blocked in
 *   Playwright's WebKit (verified: the element reaches paused === false).
 *   WebKit's real limitation is CODECS, not autoplay: the bundled build
 *   has no H.264/AAC decoders and stalls at HAVE_METADATA forever (see
 *   the decode probe in playback.spec.ts for how the suite handles that
 *   per platform).
 *
 * This table is the one source of truth: playwright.config.ts spreads it
 * into each project (for the default `page` fixture) and the playback
 * suite's per-test `roomBrowser` fixture launches through
 * `launchEngineBrowser` below.
 */
export const ENGINE_LAUNCH_OPTIONS: Readonly<Record<EngineName, LaunchOptions>> = {
    chromium: {
        args: ['--autoplay-policy=no-user-gesture-required'],
    },
    firefox: {
        // Firefox pref names are dotted by design; the project naming
        // convention cannot apply to them.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.enabled.user-gestures-needed': false },
    },
    webkit: {},
};

/** Launchers for each engine, taken from the Playwright instance in scope. */
export type EngineLaunchers = Readonly<Record<EngineName, BrowserType<LaunchOptions>>>;

/**
 * Launches one browser for the named engine with the shared per-engine
 * options. Unknown names fall back to chromium (the config only defines
 * chromium/firefox/webkit projects, so this is a defensive default).
 */
export function launchEngineBrowser(launchers: EngineLaunchers, engine: string, headless?: boolean): Promise<Browser> {
    const resolved: EngineName = (['chromium', 'firefox', 'webkit'] as const).includes(
        engine as EngineName,
    )
        ? (engine as EngineName)
        : 'chromium';
    return launchers[resolved].launch({ ...ENGINE_LAUNCH_OPTIONS[resolved], ...(headless === undefined ? {} : { headless }) });
}
