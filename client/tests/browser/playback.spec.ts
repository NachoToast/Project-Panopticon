import { expect, test as base, type Browser, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestIssueStoreHandle } from '../fixtures/testSettings';
import { launchEngineBrowser } from './engineLaunch';
import { startRoomServer, type RoomServer } from './roomServer';

/**
 * Playback integration suite: REAL chromium, firefox, and webkit, REAL
 * fixture media, REAL server application (one per test), REAL client
 * wiring. These are smoke-grade checks of the wiring — deep behavioral
 * coverage lives in the unit suite through the player harness. Every wait
 * is event-driven (expect.poll / waitFor), no fixed sleeps.
 *
 * Each test gets its own room server AND its own browser: the server keeps
 * the first-connector-is-host rule deterministic, and a fresh browser
 * sidesteps a headless-chromium media-clock leak where pages created after
 * earlier tests played videos stall at currentTime 0 forever (visible,
 * muted, readyState 4 — the pipeline just never ticks).
 */

const FIXTURE_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'public', 'data');

/** Media error family: any of these proves the failure was classified. */
const MEDIA_FAILURE_CODES = ['media-network', 'media-decode', 'media-unusable'] as const;

/**
 * Engine decode probe (cached per engine): loads the fixture media in a
 * bare muted <video> and waits, event-driven, for the first usable data
 * or a load error (an 8s bound only guards a dead pipeline).
 *
 * Why this exists: Playwright's bundled WebKit on macOS has no H.264/AAC
 * decoders — canPlayType answers "probably", but the pipeline stalls at
 * HAVE_METADATA with the fetch suspended forever (verified on WebKit 26.6
 * against both the vite dev server and a plain static server; VP8/VP9 WebM
 * twins stall the same way, so there is no codec to switch to). Linux
 * WebKit instead uses system GStreamer codecs (playwright install-deps
 * installs gstreamer1.0-libav), where decoding works. Chromium and
 * Firefox decode H.264/AAC on all platforms.
 *
 * Tests that need real playback depend on the `decodableMedia` fixture
 * and are skipped (with this reason) wherever the engine cannot decode;
 * they run everywhere else. Decode-independent tests (issue
 * classification of a 404, the trusted-events probe) still run on every
 * engine. Real-Safari codec coverage stays on the manual device matrix —
 * see docs/playback-troubleshooting.md.
 */
const DECODE_SKIP_REASON =
    'this engine cannot decode the H.264/AAC fixtures (Playwright WebKit/macOS stalls at HAVE_METADATA) — engine playback coverage is skipped here and runs on engines that decode; see docs/playback-troubleshooting.md';

async function probeEngineDecoding(browser: Browser): Promise<boolean> {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto('/');
        return await page.evaluate(async (): Promise<boolean> => {
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';
            video.src = '/data/red.mp4';
            return await new Promise<boolean>((resolve: (value: boolean) => void): void => {
                const bound = window.setTimeout((): void => {
                    resolve(false);
                }, 8_000);
                video.addEventListener('canplay', (): void => {
                    window.clearTimeout(bound);
                    resolve(true);
                });
                video.addEventListener('error', (): void => {
                    window.clearTimeout(bound);
                    resolve(false);
                });
                video.load();
            });
        });
    } finally {
        await context.close();
    }
}

/** Cached probe results per engine (workers run sequentially). */
const decodeProbeCache = new Map<string, Promise<boolean>>();

const test = base.extend<{ room: RoomServer; roomBrowser: Browser; decodableMedia: null }>({
    room: async ({ browser }, use: (room: RoomServer) => Promise<void>): Promise<void> => {
        // The per-test browser comes from roomBrowser; the shared one is
        // deliberately untouched here.
        void browser;
        const server = await startRoomServer();
        await use(server);
        await server.kill();
    },
    roomBrowser: async ({ playwright, browserName }, use: (browser: Browser) => Promise<void>): Promise<void> => {
        // One fresh browser per test in the CURRENT project's engine, with
        // the shared per-engine launch options (autoplay accommodations).
        const browser = await launchEngineBrowser(
            {
                chromium: playwright.chromium,
                firefox: playwright.firefox,
                webkit: playwright.webkit,
            },
            browserName,
        );
        await use(browser);
        await browser.close();
    },
    // Declared by tests that need real media decode. The probe result is
    // cached per engine (first use runs it), so the cost is once per
    // project; tests skip with a documented reason where decode fails.
    decodableMedia: async (
        { roomBrowser, browserName },
        use: (value: null) => Promise<void>,
        testInfo,
    ): Promise<void> => {
        let probe = decodeProbeCache.get(browserName);
        if (probe === undefined) {
            probe = probeEngineDecoding(roomBrowser);
            decodeProbeCache.set(browserName, probe);
        }
        const decodes = await probe;
        testInfo.skip(!decodes, DECODE_SKIP_REASON);
        await use(null);
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
async function bootHost(page: Page, room: RoomServer, media = 'red.mp4'): Promise<void> {
    await enterAs(page, cinemaUrl(room.port, media), 'host');
    // Before admission: the viewer/host controller may call play() the
    // moment a playing snapshot arrives, and an AUDIBLE play in headless
    // stalls permanently even if muted later.
    await prepareForHeadless(page);
    await untilVideo(page, (state) => !state.hidden && state.controls, 'visible with controls');
}

/**
 * Headless media accommodations, test-side only:
 * - AUDIBLE media stalls at currentTime 0 in headless chromium (no audio
 *   device drives the clock); muted media advances normally. The
 *   controller never touches `muted`. Muting in every engine keeps the
 *   suite's behavior uniform (firefox/webkit would also play audibly).
 * - The 3s fixture clips would end mid-wait, and end-of-media fires a
 *   GENUINE native pause (host) that correctly pauses the whole room.
 *   `loop` keeps the clips rolling so assertions are about sync, not the
 *   clip boundary. The dedicated end-of-media test opts out of this.
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

/** Mute WITHOUT looping: the end-of-media test must let the clip run out. */
async function prepareForHeadlessNoLoop(page: Page): Promise<void> {
    await page.evaluate((): void => {
        const element = document.querySelector('#movie');
        if (element instanceof HTMLVideoElement) {
            element.muted = true;
            element.loop = false;
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
    await enterAs(viewer, cinemaUrl(room.port, 'red.mp4'), 'viewer');
    // Mute/loop BEFORE approval: admission carries a playing snapshot and
    // the controller plays immediately — an audible play would stall.
    await prepareForHeadless(viewer);
    await approveFromHost(host);
    return viewer;
}

/** Clicks the first waiting-room approval button on the host page. */
async function approveFromHost(host: Page): Promise<void> {
    const approve = host.locator('#waiting-room button').first();
    await approve.waitFor({ state: 'visible', timeout: 15_000 });
    await approve.click();
}

/**
 * Re-seats an EXISTING viewer page onto different media: reload with the
 * new ?media= (the documented mismatch recovery), wait for the waiting
 * room, and approve from the host page again — a reload is a fresh
 * connection, so the host must re-admit the viewer.
 */
async function refollowViewer(host: Page, viewer: Page, room: RoomServer, media: string): Promise<void> {
    await enterAs(viewer, cinemaUrl(room.port, media), 'viewer');
    // Mute/loop BEFORE approval: admission carries a playing snapshot.
    await prepareForHeadless(viewer);
    await approveFromHost(host);
}

/** Fixture clips are 3s; playback polls stay generous but bounded. */
const PLAYBACK_TIMEOUT = 20_000;

/** Fixture clip length; the clips loop, so positions wrap at this value. */
const CLIP_LENGTH_SECONDS = 3;

test('the engine marks script-initiated media events trusted (marker policy evidence)', async ({ roomBrowser }): Promise<void> => {
    const page = await roomBrowser.newPage();
    // DESIGN PROBE for the trusted-emit policy: UA media events fired by
    // element.play() carry isTrusted === true (true in chromium, firefox,
    // and webkit — pinned per engine), so isTrusted cannot distinguish
    // programmatic from user-initiated playback. The controller therefore
    // decides trust by ORIGIN (programmatic-operation markers), not by
    // isTrusted.
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

test('host boots, is admitted, and plays the fixture media', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
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

test('an approved viewer joins mid-play and stays in sync', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
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

test('a small host seek applies precisely to the viewer', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
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

test('a host pause pauses the viewer', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);

    await pauseVideo(page);

    await untilVideo(viewer, (state) => state.paused, 'viewer paused');
});

test('a host media switch leaves the viewer mismatched and paused', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
    const page = await roomBrowser.newPage();
    await bootHost(page, room);
    await playVideo(page);
    await untilVideo(page, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(page, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);

    // The host "switches media" by reloading configured for green; the
    // viewer's page still holds red, so the new cinema:state mismatches.
    await enterAs(page, cinemaUrl(room.port, 'green.mp4'), 'host');
    await untilVideo(page, (state) => !state.hidden && state.controls, 'host readmitted');

    await expect
        .poll(async (): Promise<string[]> => issueCodes(viewer), { timeout: 20_000 })
        .toContain('media-mismatch');
    await untilVideo(viewer, (state) => state.paused, 'viewer paused locally');
});

/**
 * One media switch, host-driven: the host reloads onto `next`, the viewer
 * must surface the mismatch and pause, then follow via its own reload
 * (re-approval included) and resume playing the new clip in sync.
 */
async function switchMediaAndFollow(
    host: Page,
    viewer: Page,
    room: RoomServer,
    next: string,
): Promise<void> {
    // The host switches media by reloading configured for `next`; the
    // announcement on readmission moves the room to the new media id.
    await enterAs(host, cinemaUrl(room.port, next), 'host');
    await prepareForHeadless(host);
    await untilVideo(host, (state) => !state.hidden && state.controls, `host readmitted on ${next}`);

    // The viewer still holds the previous clip: mismatch surfaces and the
    // viewer pauses locally (never commanding the room back).
    await expect
        .poll(async (): Promise<string[]> => issueCodes(viewer), { timeout: 20_000 })
        .toContain('media-mismatch');
    await untilVideo(viewer, (state) => state.paused, 'viewer paused locally');

    // The documented recovery: the viewer reloads onto the new media.
    // A reload is a fresh connection, so the host re-approves. The select
    // RESET the room (paused at position 0), so the resynced viewer is
    // admitted paused at the reset position until the host plays again.
    await refollowViewer(host, viewer, room, next);
    await untilVideo(
        viewer,
        (state) => !state.hidden && state.controls && state.paused && state.ready >= 2 && state.position <= 0.5,
        `viewer readmitted on ${next}, paused at the reset position`,
    );
    await expect
        .poll(async (): Promise<string[]> => issueCodes(viewer), { timeout: 20_000 })
        .not.toContain('media-mismatch');

    // The host resumes the room; the viewer must follow into playback.
    await playVideo(host);
    await untilVideo(
        viewer,
        (state) => !state.paused && !state.hidden && state.ready >= 2,
        `viewer playing ${next}`,
        PLAYBACK_TIMEOUT,
    );
}

test('viewer follows successive host media switches through reloads (red → green → blue)', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
    const host = await roomBrowser.newPage();
    await bootHost(host, room); // red by default
    await playVideo(host);
    await untilVideo(host, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(host, roomBrowser, room); // red too
    await untilVideo(
        viewer,
        (state) => !state.paused && !state.hidden && state.ready >= 2,
        'viewer playing red',
        PLAYBACK_TIMEOUT,
    );

    await switchMediaAndFollow(host, viewer, room, 'green.mp4');
    await switchMediaAndFollow(host, viewer, room, 'blue.mp4');
});

test('end of media pauses the whole room once, without a restart loop', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
    const host = await roomBrowser.newPage();
    await bootHost(host, room);
    await playVideo(host);
    await untilVideo(host, (state) => state.position >= 0.3, 'host advancing', PLAYBACK_TIMEOUT);

    const viewer = await seatViewer(host, roomBrowser, room);
    await untilVideo(viewer, (state) => !state.paused && state.ready >= 2, 'viewer playing', PLAYBACK_TIMEOUT);

    // The staging below needs the HOST's media clock; seating the viewer
    // left the viewer's page in front and chromium throttles media clocks
    // in occluded pages (see enterAs).
    await host.bringToFront();

    // Rewind the room (both clips still LOOP — no boundary can fire during
    // this staging), wait for the host to pass ~1s, then rewind ONLY the
    // viewer (a non-admin local seek is legal within the drift threshold).
    // The viewer trails the host by however far the host had advanced, so
    // when the host later runs out the room pause lands while the viewer
    // is still mid-play. NOTE: the host wait must be a LOWER BOUND only —
    // a windowed range aliases with the poll cadence (samples ~1s apart
    // lock-step around a 3s cycle and can skip a narrow window forever).
    await seekVideo(host, 0);
    await untilVideo(viewer, (state) => state.position < 0.5, 'viewer rewound with the room');
    await untilVideo(host, (state) => state.position >= 0.9, 'host past one second', PLAYBACK_TIMEOUT);
    await seekVideo(viewer, 0);
    await untilVideo(viewer, (state) => state.position < 0.5, 'viewer rewound itself');

    // NOW opt out of the loop accommodation: this test needs the clips to
    // run out for real (un-looping last avoids a boundary firing mid-setup).
    await prepareForHeadlessNoLoop(host);
    await prepareForHeadlessNoLoop(viewer);

    // End-of-media fires a GENUINE native pause on the host element, which
    // commands the room pause exactly like a host-clicked pause. There is
    // no 'ended' listener in the controller — nothing may auto-restart.
    // The trailing viewer must receive that room-wide pause while still
    // mid-play: paused but NOT ended proves the pause came from the room
    // rather than the viewer's own clip boundary.
    await untilVideo(host, (state) => state.ended, 'host clip ran out', PLAYBACK_TIMEOUT);
    await untilVideo(host, (state) => state.paused && state.position >= CLIP_LENGTH_SECONDS - 0.25, 'host paused at the end');

    await untilVideo(viewer, (state) => state.paused && !state.ended, 'room pause reached the viewer', PLAYBACK_TIMEOUT);

    // No failure classification and no crash: natural end is not a media
    // error, and the element stays usable/visible.
    const issues = await issueCodes(host);
    for (const code of MEDIA_FAILURE_CODES) {
        expect(issues, `host must not report ${code}`).not.toContain(code);
    }
    const hostState = await videoState(host);
    expect(hostState?.ended).toBe(true);
    expect(hostState?.controls).toBe(true);
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

test('a truncated media file classifies as a media failure without crashing', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
    // Construct the fixture at test time: a 40%-length prefix of the
    // engine's red clip. The mp4's +faststart puts the moov atom first, so
    // it survives the cut and the element boots — then playback runs off
    // the end of the available data mid-stream, a DIFFERENT failure from
    // the bogus clip's plain 404. Engines report truncation differently
    // (decode error, network error, or an unusable source), so the
    // assertion is on the failure FAMILY.
    const source = join(FIXTURE_DATA_DIR, 'red.mp4');
    const full = await readFile(source);
    const truncated = join(FIXTURE_DATA_DIR, 'truncated.mp4');
    await writeFile(truncated, full.subarray(0, Math.floor(full.length * 0.4)));

    const page = await roomBrowser.newPage();
    await enterAs(page, cinemaUrl(room.port, 'truncated.mp4'), 'host');
    await prepareForHeadless(page);
    await untilVideo(page, (state) => !state.hidden, 'admitted with media visible');
    await playVideo(page);

    await expect
        .poll(
            async (): Promise<boolean> => {
                const codes = await issueCodes(page);
                return MEDIA_FAILURE_CODES.some((code) => codes.includes(code));
            },
            {
                timeout: 25_000,
                message: 'waiting for the truncated-media failure to classify',
            },
        )
        .toBe(true);

    // No crash: the fallback stays hidden and the element stays queryable.
    const fallbackHidden = await page.evaluate((): boolean => {
        const fallback = document.querySelector('#startup-fallback');
        return fallback === null || !(fallback instanceof HTMLElement) || (fallback.hidden as boolean);
    });
    expect(fallbackHidden).toBe(true);
    expect(await videoState(page)).not.toBeNull();
});

test('losing the server pauses and recovers after a restart', async ({ room, roomBrowser, decodableMedia }): Promise<void> => {
    void decodableMedia;
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
