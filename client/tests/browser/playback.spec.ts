import { expect, test as base, type Browser, type Page } from '@playwright/test';
import type { TestIssueStoreHandle } from '../fixtures/testSettings';
import { startRoomServer, type RoomServer } from './roomServer';

/**
 * Playback integration suite: REAL chromium, REAL fixture media, REAL
 * server application (one per test), REAL client wiring. These are
 * smoke-grade checks of the wiring — deep behavioral coverage lives in the
 * unit suite through the player harness. Every wait is event-driven
 * (expect.poll / waitFor), no fixed sleeps.
 *
 * Each test gets its own room server AND its own browser: the server keeps
 * the first-connector-is-host rule deterministic, and a fresh browser
 * sidesteps a headless-chromium media-clock leak where pages created after
 * earlier tests played videos stall at currentTime 0 forever (visible,
 * muted, readyState 4 — the pipeline just never ticks).
 */

const test = base.extend<{ room: RoomServer; roomBrowser: Browser }>({
    room: async ({ browser }, use: (room: RoomServer) => Promise<void>): Promise<void> => {
        // The per-test browser comes from roomBrowser; the shared one is
        // deliberately untouched here.
        void browser;
        const server = await startRoomServer();
        await use(server);
        await server.kill();
    },
    roomBrowser: async ({ playwright }, use: (browser: Browser) => Promise<void>): Promise<void> => {
        const browser = await playwright.chromium.launch({
            args: ['--autoplay-policy=no-user-gesture-required'],
        });
        await use(browser);
        await browser.close();
    },
});

/** The client page URL pointing at this test's room server. */
function cinemaUrl(port: number, media?: string): string {
    const params = new URLSearchParams({ server: `ws://localhost:${String(port)}` });
    if (media !== undefined) {
        params.set('media', media);
    }
    return `http://localhost:1732/?${params.toString()}`;
}

/** Walks the entry card: username typed, Enter pressed, connection starts. */
async function enterAs(page: Page, url: string, name: string): Promise<void> {
    await page.goto(url);
    // A previous test's viewer context can still hold the browser's active
    // window; Chromium throttles media clocks in occluded pages.
    await page.bringToFront();
    const input = page.locator('#username-input');
    await input.waitFor({ state: 'visible', timeout: 15_000 });
    await input.fill(name);
    await input.press('Enter');
}

/** Serializable view of the #movie element's playback-relevant state. */
interface VideoState {
    readonly hidden: boolean;
    readonly controls: boolean;
    readonly paused: boolean;
    readonly ended: boolean;
    readonly ready: number;
    readonly position: number;
}

async function videoState(page: Page): Promise<VideoState | null> {
    return page.evaluate((): VideoState | null => {
        const element = document.querySelector('#movie');
        if (!(element instanceof HTMLVideoElement)) {
            return null;
        }
        return {
            // The reflected attribute types as string|boolean; the runtime
            // value is always a boolean here.
            hidden: element.hidden as boolean,
            controls: element.controls,
            paused: element.paused,
            ended: element.ended,
            ready: element.readyState,
            position: element.currentTime,
        };
    });
}

/** Waits (polling the live element) until the predicate holds. */
async function untilVideo(
    page: Page,
    holds: (state: VideoState) => boolean,
    description: string,
    timeout = 20_000,
): Promise<void> {
    await expect
        .poll(
            async (): Promise<boolean> => {
                const state = await videoState(page);
                return state !== null && holds(state);
            },
            { timeout, message: `waiting for video: ${description}` },
        )
        .toBe(true);
}

/** Active issue codes from the test-exposed issue store (test builds only). */
async function issueCodes(page: Page): Promise<string[]> {
    return page.evaluate((): string[] => {
        const store = (globalThis as Record<string, unknown>)['__panopticonIssues'] as
            | TestIssueStoreHandle
            | undefined;
        return store === undefined ? [] : store.getIssueSnapshot().issues.map((issue) => issue.code);
    });
}

/** Genuine native interactions driven from page script (no UI exists yet). */
async function playVideo(page: Page): Promise<void> {
    await page.evaluate((): void => {
        const element = document.querySelector('#movie');
        if (element instanceof HTMLVideoElement) {
            // The controller did not initiate this play: it must count as a
            // genuine native control event under the marker policy.
            void element.play();
        }
    });
}

async function pauseVideo(page: Page): Promise<void> {
    await page.evaluate((): void => {
        const element = document.querySelector('#movie');
        if (element instanceof HTMLVideoElement) {
            element.pause();
        }
    });
}

async function seekVideo(page: Page, position: number): Promise<void> {
    await page.evaluate((target: number): void => {
        const element = document.querySelector('#movie');
        if (element instanceof HTMLVideoElement) {
            element.currentTime = target;
        }
    }, position);
}

/** Host entered + admitted: video visible with controls. */
async function bootHost(page: Page, room: RoomServer, media?: string): Promise<void> {
    await enterAs(page, cinemaUrl(room.port, media), 'host');
    // Before admission: the viewer/host controller may call play() the
    // moment a playing snapshot arrives, and an AUDIBLE play in headless
    // stalls permanently even if muted later.
    await prepareForHeadless(page);
    await untilVideo(page, (state) => !state.hidden && state.controls, 'visible with controls');
}

/**
 * Headless-chromium accommodations, test-side only:
 * - AUDIBLE media stalls at currentTime 0 (no audio device drives the
 *   clock); muted media advances normally. The controller never touches
 *   `muted`.
 * - The 3s fixture clips would end mid-wait, and end-of-media fires a
 *   GENUINE native pause (host) that correctly pauses the whole room.
 *   `loop` keeps the clips rolling so assertions are about sync, not the
 *   clip boundary.
 */
async function prepareForHeadless(page: Page): Promise<void> {
    await page.evaluate((): void => {
        const element = document.querySelector('#movie');
        if (element instanceof HTMLVideoElement) {
            element.muted = true;
            element.loop = true;
        }
    });
}

/** Enters a viewer and approves them from the host page. */
async function seatViewer(
    host: Page,
    browser: Browser,
    room: RoomServer,
): Promise<Page> {
    const context = await browser.newContext();
    const viewer = await context.newPage();
    await enterAs(viewer, cinemaUrl(room.port), 'viewer');
    // Mute/loop BEFORE approval: admission carries a playing snapshot and
    // the controller plays immediately — an audible play would stall.
    await prepareForHeadless(viewer);
    const approve = host.locator('#waiting-room button').first();
    await approve.waitFor({ state: 'visible', timeout: 15_000 });
    await approve.click();
    return viewer;
}

/** Fixture clips are 3s; playback polls stay generous but bounded. */
const PLAYBACK_TIMEOUT = 20_000;

/** Fixture clip length; the clips loop, so positions wrap at this value. */
const CLIP_LENGTH_SECONDS = 3;

test('chromium marks script-initiated media events trusted (marker policy evidence)', async ({ roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    // DESIGN PROBE for the trusted-emit policy: UA media events fired by
    // element.play() carry isTrusted === true, so isTrusted cannot
    // distinguish programmatic from user-initiated playback. The controller
    // therefore decides trust by ORIGIN (programmatic-operation markers),
    // not by isTrusted.
    const trusted = await page.evaluate(async (): Promise<boolean | null> => {
        const video = document.createElement('video');
        let seen: boolean | null = null;
        video.addEventListener('play', (event: Event): void => {
            seen = event.isTrusted;
        });
        // A sourceless element's play() promise can stay pending forever,
        // so fire it and let the event settle instead of awaiting.
        void video.play().catch((): void => undefined);
        await new Promise<void>((resolve): void => {
            setTimeout((): void => {
                resolve();
            }, 100);
        });
        return seen;
    });
    expect(trusted).toBe(true);
});

test('host boots, is admitted, and plays the fixture media', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);

    await playVideo(page);

    await untilVideo(
        page,
        (state) => !state.paused && state.ready >= 2 && state.position >= 1,
        'playing and advancing',
        PLAYBACK_TIMEOUT,
    );
    const issues = await issueCodes(page);
    expect(issues).not.toContain('media-network');
    expect(issues).not.toContain('media-unusable');
});

test('an approved viewer joins mid-play and stays in sync', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    // Rewind the host so the late joiner has runway before the 3s clip ends.
    await seekVideo(page, 0);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(
        viewer,
        (state) => !state.paused && !state.hidden && state.ready >= 2,
        'viewer playing',
        PLAYBACK_TIMEOUT,
    );

    const [hostState, viewerState] = await Promise.all([videoState(page), videoState(viewer)]);
    expect(hostState).not.toBeNull();
    expect(viewerState).not.toBeNull();
    // Wrap-aware: the clips loop at 3s, so one page reading just before a
    // wrap and the other just after shows ~3s of RAW drift despite being
    // in perfect sync — that reads as ~0s instead.
    const raw = Math.abs((hostState?.position ?? 0) - (viewerState?.position ?? 0));
    const drift = Math.min(raw, CLIP_LENGTH_SECONDS - raw);
    expect(drift).toBeLessThan(1.5);
});

test('a small host seek applies precisely to the viewer', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);
    await seekVideo(page, 0);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);
    await untilVideo(page, (state) => state.position >= 0.5 && state.position < 2, 'host near 1s');

    // 1 -> 2 seconds: under the 5s drift threshold, must still apply exactly.
    await seekVideo(page, 2);

    await untilVideo(
        viewer,
        (state) => state.position >= 1.8 && state.position <= 2.6,
        'viewer follows the seek',
        PLAYBACK_TIMEOUT,
    );
});

test('a host pause pauses the viewer', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);

    await pauseVideo(page);

    await untilVideo(viewer, (state) => state.paused, 'viewer paused');
});

test('a host media switch leaves the viewer mismatched and paused', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);

    // The host "switches media" by reloading configured for green.mp4; the
    // viewer's page still holds red.mp4, so the new cinema:state mismatches.
    await enterAs(page, cinemaUrl(room.port, 'green.mp4'), 'host');
    await untilVideo(page, (state) => !state.hidden && state.controls, 'host readmitted');

    await expect
        .poll(async (): Promise<string[]> => issueCodes(viewer), { timeout: 20_000 })
        .toContain('media-mismatch');
    await untilVideo(viewer, (state) => state.paused, 'viewer paused locally');
});

test('missing media reports unusable and never crashes', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await enterAs(page, cinemaUrl(room.port, 'bogus.mp4'), 'host');
    await untilVideo(page, (state) => !state.hidden, 'admitted with media visible');

    await expect
        .poll(async (): Promise<string[]> => issueCodes(page), {
            timeout: 25_000,
            message: 'waiting for the media failure to classify',
        })
        .toContain('media-unusable');

    // No crash: the fallback stays hidden and the element stays queryable.
    const fallbackHidden = await page.evaluate((): boolean => {
        const fallback = document.querySelector('#startup-fallback');
        return fallback === null || !(fallback instanceof HTMLElement) || (fallback.hidden as boolean);
    });
    expect(fallbackHidden).toBe(true);
    expect(await videoState(page)).not.toBeNull();
});

test('losing the server pauses and recovers after a restart', async ({ room, roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    await room.kill();

    await untilVideo(
        page,
        (state) => state.paused && state.hidden && !state.controls,
        'paused and hidden on disconnect',
    );
    await expect
        .poll(async (): Promise<string[]> => issueCodes(page), { timeout: 10_000 })
        .toContain('connection-lost');

    await room.restart();

    // Socket.IO reconnection (with backoff) leads to re-admission: visible
    // with controls again, the incident resolved.
    await untilVideo(page, (state) => !state.hidden && state.controls, 'readmitted after restart', 30_000);
    await expect
        .poll(async (): Promise<string[]> => issueCodes(page), { timeout: 30_000 })
        .not.toContain('connection-lost');
});
