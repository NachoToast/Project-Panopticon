# Project Panopticon

A synchronized group movie-watching application — a virtual cinema where multiple users can watch video together in real time. The first user to connect becomes the admin (host) and controls playback (play, pause, seek). All other users join a waiting room and must be approved by the admin before entering the cinema.

## Architecture

The project is split into three workspaces:

| Workspace | Runtime | Port | Description |
|-----------|---------|------|-------------|
| `client/` | Vite + TypeScript | 1730 | Web frontend with a synchronized video player |
| `server/` | Node.js + Socket.IO | 5000 | WebSocket backend managing rooms and sync |
| `converter/` | Bun + ffmpeg | — | CLI tool to batch-transcode video files for streaming |

### Key Concepts

- **Admin** — The first user to connect. Controls playback and can approve, kick, or ban users from the waiting room.
- **Cinema** — The main room where approved users watch video together. Playback state (playing/paused/time) is synchronized by the admin.
- **Waiting Room** — Where non-admin users wait until approved by the admin.

### Shared Types

The `client/src/shared/` and `server/src/shared/` directories contain mirrored type definitions:

- `BaseUser` — Minimal user representation (`id`, `username`, `isAdmin`, `joinedAt`)
- `ClientEvents` — Events sent from client to server (`cinema:play`, `cinema:pause`, `cinema:seek`, `admin:kick`, `admin:ban`, `admin:approve`)
- `ServerEvents` — Events sent from server to client (`connection:accepted/rejected`, `cinema:joined/left/users/playing/paused/seeked`, `waiting-room:joined/left`, `admin:added/left/users/kicked/banned/approved`)

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/)
- [Bun](https://bun.sh/) (only needed for the converter)
- [ffmpeg](https://ffmpeg.org/) (only needed for the converter)

## Setup

### 1. Install dependencies

```sh
cd client && pnpm install
cd ../server && pnpm install
```

### 2. Configure the client

Create `client/settings.json` from the example:

```sh
cp client/settings.example.json client/settings.json
```

Then edit `client/settings.json` to point to your video file and optional subtitles:

```json
{
    "file": "movie.mp4",
    "type": "video/mp4",
    "subtitles": [
        {
            "label": "English",
            "file": "english.vtt",
            "srclang": "en"
        }
    ]
}
```

Place your video file under `client/public/data/`.

### 3. Configure the server

Create a `.env` file in `server/` (used by the dev command):

```sh
echo "PORT=5000" > server/.env
```

## Running

### Development

Start the server and client in separate terminals:

```sh
# Terminal 1 — Server (auto-restarts on file changes)
cd server && pnpm dev

# Terminal 2 — Client (hot module replacement)
cd client && pnpm dev
```

- Client: http://localhost:1730
- Server: http://localhost:5000

### Production

```sh
# Build both
cd client && pnpm build
cd ../server && pnpm build

# Start the server
cd server && pnpm start

# Start the client (serves the built assets)
cd client && pnpm start
```

### Converter

```sh
cd converter && bun install
bun run dev
```

Prompts for a folder path and file extension, then transcodes all matching files using ffmpeg (H.264/AAC, CRF 22, `+faststart`) into a `transcoded/` subdirectory.

## Code Quality

Each workspace has a `check-all` script that runs typechecking and linting:

```sh
# Run in each workspace
cd client && pnpm check-all
cd ../server && pnpm check-all
cd ../converter && bun run check-all
```

Or individually:

```sh
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint
```

### Formatting

This project uses [Prettier](https://prettier.io/) and [EditorConfig](https://editorconfig.org/) for consistent formatting:

- 4-space indentation
- Single quotes
- Trailing commas
- LF line endings

## Project Structure

```
Project-Panopticon/
├── client/                    # Vite web frontend
│   ├── public/data/           # Video and subtitle files (gitignored)
│   ├── settings.json          # Video configuration (gitignored)
│   ├── settings.example.json  # Example configuration
│   └── src/
│       ├── controllers/       # UI controllers (cinema, movie, sidebar, user, etc.)
│       ├── shared/            # Shared types (BaseUser, ClientEvents, ServerEvents)
│       ├── styles/            # CSS
│       └── util/              # Utilities
├── server/                    # Node.js + Socket.IO backend
│   └── src/
│       ├── Rooms/             # Room implementations (Admins, Cinema, WaitingRoom)
│       ├── shared/            # Shared types (mirrors client)
│       ├── User.ts            # User class
│       └── validation.ts      # Connection validation (username, IP bans, etc.)
└── converter/                 # Bun-based ffmpeg batch transcoder
    └── src/
        ├── doTranscode.ts     # ffmpeg transcoding logic
        └── getInputs.ts       # CLI prompts for folder/extension
```

## How It Works

1. User opens the client and enters a username.
2. The client connects to the server via WebSocket (Socket.IO).
3. The server validates the connection (username format, duplicates, IP bans).
4. The first user becomes the **admin** and joins the cinema directly.
5. Subsequent users enter the **waiting room**.
6. The admin can approve waiting users into the cinema.
7. The admin controls video playback — play, pause, and seek events are broadcast to all cinema members.
8. Late-joining cinema members receive the current playback state on join.

## License

MIT
