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

const ALLOWED_MEDIA = /^(?:red|green|blue|bogus)\.mp4$/;

const requested = new URLSearchParams(window.location.search).get('media') ?? '';
const file = ALLOWED_MEDIA.test(requested) ? requested : 'red.mp4';

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
