@ECHO OFF
SET PORT=5000
pnpm install --reporter=silent && pnpm build && pnpm start
