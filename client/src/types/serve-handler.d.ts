// Ambient declaration for serve-handler, the production static handler used
// by client/serve.mjs. The package ships untyped JavaScript, so this covers
// the option surface the server configures and leaves the rest untyped.

declare module 'serve-handler' {
    import type { IncomingMessage, ServerResponse } from 'node:http';

    export interface ServeHandlerHeaderEntry {
        key: string;
        value: string;
    }

    export interface ServeHandlerHeaderRule {
        source: string;
        headers: ServeHandlerHeaderEntry[];
    }

    export interface ServeHandlerConfig {
        /** Directory to serve (absolute, or relative to the process cwd). */
        public?: string;
        /** Serve `foo.html` at `foo` and resolve `/` to `index.html`. */
        cleanUrls?: boolean;
        /** Render directory listings for matching paths. */
        directoryListing?: boolean;
        /** Follow symlinks instead of answering them with 404. */
        symlinks?: boolean;
        /**
         * Strong `ETag` headers. Disabled in production: the implementation
         * SHA-1 hashes the ENTIRE file, which is unacceptable for media.
         */
        etag?: boolean;
        /** Extra response headers (e.g. Cache-Control) per path glob. */
        headers?: ServeHandlerHeaderRule[];
    }

    const serveHandler: (request: IncomingMessage, response: ServerResponse, config?: ServeHandlerConfig) => Promise<void>;

    export default serveHandler;
}
