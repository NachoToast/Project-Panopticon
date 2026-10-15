# Playback troubleshooting

Operator-facing guide for diagnosing "the video doesn't play" reports.
Everything here describes implemented behavior — where something is not
covered by automation, it says so explicitly.

## How to read a playback failure

The client maintains a local issue store. `exportDiagnostics()`
(`client/src/diagnostics/issues.ts`) renders a plain-text report — but
there is no in-app export button yet; it ships in a forthcoming
release. Until then the export is reachable programmatically (the
browser tests read the same store). To diagnose a live report in the
meantime, collect manually: the browser and its exact version, the
page URL, the devtools console output, and what the network panel
shows for the media request (status, content type, whether the
response body loads at all).

What the report contains — and nothing else:

- `Engine:` the coarse browser family (e.g. `chromium`, `firefox`, `webkit`).
- Active issues: `code`, severity, whether blocking, occurrence count,
  first/last seen, and for media issues the `media=` id and
  `mediaErrorCode` (1–5) when the engine provided one.
- A bounded diagnostic history: buffering events (`media-waiting`,
  `media-stalled`) with `readyState` readings, and play rejections with
  the DOMException name (e.g. `NotAllowedError`).

The report header states the privacy contract: it is local-only debug
information, never collected or uploaded. No usernames, URLs, tokens, or
raw error text appear in it.

Issue codes you will actually see:

| Code | Meaning (what is proven) | Typical next step |
| --- | --- | --- |
| `playback-interaction-required` | The browser blocked the start until a user gesture; a play promise was rejected with `NotAllowedError` | The user presses play once; nothing is broken |
| `media-network` / `media-decode` | The media element reported a network or decode failure for the current source | Direct-media comparison (below) |
| `media-unusable` | The source could not be used at all (404, HTML served instead of video, unusable source child) | Check the file exists at its `/data/` URL and is really a video |
| `media-mismatch` | The room watches different media than this page loaded | Reload — the mismatch recovery is the reload action |
| `connection-lost` | The socket transport dropped | Wait for reconnect or reload |
| `slow-loading` (info, non-blocking) | Data is arriving slower than playback needs | Network path, not the app |

## Common causes vs unproven assumptions

Established causes (each pinned by a test):

- **Media missing or HTML served instead of video** → the source fails;
  classified `media-unusable`. Serve-handler's SPA fallback makes a
  wrong URL return `index.html` with status 200, which surfaces the same
  way — check the URL, not just the status.
- **Browser autoplay policy** → an audible start without a user gesture
  is rejected (`playback-interaction-required`). One click resolves it.
- **Media mismatch after the host switches media** → the viewer pauses
  locally with `media-mismatch` and never commands the room; reloading
  onto the new media (with re-approval) resynchronizes. A media switch
  also resets the room to paused-at-0 by design — the host presses play
  again.
- **Network/decode failure** → classified into the media family above;
  the app never guesses a reason beyond what the engine reported.

Unproven — do NOT assert these without evidence from the report or the
direct-media check:

- "An extension is blocking it." A failed request does not prove an
  extension intervened. (Playback-error events can carry an
  `origin=EXTENSION_ORIGIN` marker when the engine attributes the error
  to extension-modified behavior — only that marker justifies the claim.)
- "The codec is broken." A decode failure on one machine may be a
  truncated file, a proxy, or a GPU driver. Compare with the direct-media
  procedure before blaming the encode.

## Direct-media comparison procedure

Open the exact media URL directly in the failing browser:
`https://<host>/data/<file>`. This bypasses the app entirely.

- **The video plays in the tab** → serving and codecs are fine; the
  failure is in app state (mismatch, autoplay gesture, connection). Get
  the diagnostics export.
- **An error page or the HTML page appears** → the URL is wrong or the
  file is missing; `media-unusable` in the app was correct.
- **Download starts instead of playing / the player shows an error** →
  the file or codec is the problem for that browser. Note the engine
  from the report and compare on a second machine before concluding the
  encode is bad.
- **It stalls partway** → suspect a truncated file or a mid-stream cut;
  chromium and firefox classify this in the media family, and the app
  must not crash on any engine (pinned by the truncated-fixture browser
  test).

## Known serving gaps (serve.mjs)

The production static server intentionally defers some HTTP niceties;
none of these break playback, but they explain traffic patterns:

- **No conditional revalidation**: `Last-Modified` is decorative; media
  re-downloads fully on reuse instead of answering `304` to
  `If-Modified-Since`.
- **Multi-range requests are truncated** to the first range (browsers
  never send multi-range for plain `<video>` playback, so this is
  cosmetic today).
- **`416` responses carry a full body** rather than an empty one.
- **`/index.html` 301s to `/index`**, then `/` — a two-hop redirect
  instead of one.

## Converter envelope rejections

The converter refuses inputs that cannot fit its H.264 level 4.1
envelope *before* encoding anything, with measured numbers in the
message (`exceeds-max-frame-size`, `exceeds-max-frame-rate`, or an
unusable-probe code). This is deliberate: silently producing a file with
a lying level flag would just move the failure to playback time.

What to do: re-encode the source smaller (resolution or frame rate), or
pick a different level for that batch. The converter does not
auto-downscale.

## Manual device test matrix — PENDING, not automated

The automated browser matrix covers real chromium, firefox, and webkit
*builds*; it does not cover the browsers the original incidents happened
in. Until this matrix is executed and recorded, treat real-device
playback as unverified:

- [ ] macOS Safari (the Playwright webkit build cannot stand in — see
      "What we do NOT claim")
- [ ] Arc, regular and private windows
- [ ] Windows Chrome, regular and private
- [ ] Windows Firefox, regular and private
- [ ] Each of the above across at least two different videos
- [ ] Zen browser and one Linux desktop browser

## What we do NOT claim

- We do not blame extensions without the `EXTENSION_ORIGIN` marker or an
  equivalent reproduction with the extension disabled.
- We do not blame the codec without the direct-media comparison failing
  in a real browser.
- Passing tests in automation browser engines **is not** evidence about
  the original user incidents, which happened in browsers the matrix
  does not include (see the pending manual matrix).
- Playwright's bundled WebKit is only partially covered, on purpose: its
  macOS build cannot decode H.264/AAC at all, and its media clock stalls
  permanently after seeking a playing element (both verified; see the
  README's browser-matrix section). A green webkit run exercises wiring,
  decode-independent paths, and — on Linux — basic playback, but it says
  nothing about real Safari.
- The server's `Last-Modified`/multi-range gaps are known and
  deliberate, not oversights waiting for a bug report.
