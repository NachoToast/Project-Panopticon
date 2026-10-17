import { issueStore } from '../../src/diagnostics/issues';

/**
 * TEST-ONLY settings module: the alias target for the settings.json import
 * when the client is served through vite.test.config.ts.
 *
 * It picks the fixture clip from the page's ?media= query parameter (an
 * allowlist — never an arbitrary path), defaulting to red.mp4. Production
 * builds never see this module; they read the real client/settings.json.
 *
 * It also exposes the (singleton) issue store on globalThis so browser
 * tests can assert diagnostics issues without any production UI existing
 * yet (the issues surface ships in PR 2).
 */

// bogus.mp4 is allowlisted deliberately: it is the missing-media fixture
// the browser suite uses to pin the unusable-source failure path (no such
// file exists on disk — it 404s). truncated.mp4 also does not exist on
// disk: the browser suite writes it at test time (a prefix of red.mp4)
// to pin the corrupt/truncated-source path.
const ALLOWED_MEDIA = /^(?:red|green|blue|bogus|truncated)\.mp4$/;

const requested = new URLSearchParams(window.location.search).get('media');
const file = requested !== null && ALLOWED_MEDIA.test(requested) ? requested : 'red.mp4';
if (requested !== null && file !== requested) {
    // Test builds only: a typo'd ?media= would otherwise silently boot
    // red.mp4 and surface later as a confusing 'mismatch' failure.
    console.warn(
        `[panopticon-tests] unrecognized ?media= value "${requested}"; ` +
            `falling back to red.mp4 (allowlist: red|green|blue|bogus|truncated .mp4)`,
    );
}

const settings = {
    file,
    type: 'video/mp4',
    subtitles: [],
};

/** Browser-side handle the tests cast the exposed store to. */
export interface TestIssueStoreHandle {
    getIssueSnapshot(): { issues: { code: string }[] };
}

(globalThis as Record<string, unknown>)['__panopticonIssues'] = issueStore;

export default settings;
