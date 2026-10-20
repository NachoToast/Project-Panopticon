import type { Browser, BrowserType, LaunchOptions } from '@playwright/test';

/**
 * The engines the browser suite runs (one Playwright project each).
 * This array is the single source of truth for the engine set: the
 * EngineName union is derived from it, playwright.config.ts builds its
 * projects table from it, and launchEngineBrowser validates against it.
 */
export const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

/** Is `value` one of ENGINE_NAMES? */
function isEngineName(value: string): value is EngineName {
    return (ENGINE_NAMES as readonly string[]).includes(value);
}

/**
 * Per-engine launch options for REAL media playback in the harness.
 *
 * Each engine needs its own accommodation so media never depends on a user
 * gesture during tests:
 * - chromium: the `--autoplay-policy` command-line flag.
 * - firefox: autoplay is governed by about:config prefs, not command-line
 *   flags. `media.autoplay.default: 0` allows all autoplay and
 *   `media.autoplay.enabled.user-gestures-needed: false` stops gesture
 *   activation from overriding the default.
 * - webkit: no options needed, muted play() is not gesture-blocked in
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
        // Firefox pref names are dotted by design, the project naming
        // convention cannot apply to them.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.enabled.user-gestures-needed': false },
    },
    webkit: {},
};

/**
 * The `playwright` test fixture, structurally: its engine members are
 * keyed by EngineName (the full module namespace satisfies this).
 */
type EngineModule = Readonly<Record<EngineName, BrowserType>>;

/**
 * Launches one browser for the named engine with the shared per-engine
 * options. Unknown names throw (fail loud): a silent fallback could mask
 * a misconfigured project by quietly running the wrong engine.
 */
export function launchEngineBrowser(playwright: EngineModule, engine: string): Promise<Browser> {
    if (!isEngineName(engine)) {
        throw new Error(`unknown browser engine "${engine}" (expected one of: ${ENGINE_NAMES.join(', ')})`);
    }
    return playwright[engine].launch(ENGINE_LAUNCH_OPTIONS[engine]);
}
