# Shadowlatch

Temporary chat rooms for moving text and code between devices. Open a room, share the 12-character code, paste. One hour after the last message the room is deleted.

Static site (GitHub Pages) + Firebase (Firestore + Anonymous Auth). No server, no build step.

## Security model

- **The code is the only door.** Room id = 12 random symbols (60 bits, `crypto.getRandomValues`). `firestore.rules` has no `list` rule on `/rooms`, so rooms can't be enumerated, and a wrong, unknown or expired code returns the same denial (no oracle).
- **Expiry is enforced by the rules, not the client.** Reads and writes are denied once `expireAt` passes. Each message slides the room's expiry in the same atomic batch; the rules require the room's `last` pointer to name a message created in that write.
- **Cleanup:** a client that sees the room end deletes what it saw. On the free Spark plan Firestore TTL policies can't be enabled (they need billing), so rooms nobody was watching when they ended stay stored, but unreadable, until purged. Purge with `firebase firestore:delete /rooms --recursive` (this also kills live rooms). On Blaze, add TTL policies on `rooms.expireAt` and `messages.expireAt` for automatic removal.
- Messages are immutable, limited to 20,000 chars, `text`/`code` only, and always rendered with `textContent` (never HTML).
- Strict CSP (`script-src 'self'`, connections only to Firebase), `no-referrer`, the code lives in the URL `#fragment` (never sent to any server). Firebase SDK is vendored (`vendor/`), no third-party scripts or fonts.
- Known limits: Firestore can't add 1h to `request.time` server-side, so the rules accept a client-supplied expiry within ±10 min of the target (device clock must be roughly right). Anyone who holds the code is a full participant; Burn is available to all of them.
- Recommended: enable **Firebase App Check** (reCAPTCHA v3) and restrict the API key to `tanim913.github.io/*` in Google Cloud Console.

## Setup

1. Firebase console → create a project → **Build → Firestore Database** (production mode) and **Authentication → Sign-in method → Anonymous: enable**.
2. Project settings → Your apps → Web app → copy the config into `js/config.js`.
3. Deploy rules: `npx firebase-tools login && npx firebase-tools deploy --only firestore:rules --project <id>`
4. Authentication → Settings → Authorized domains: add `tanim913.github.io`.
5. Push to GitHub, Settings → Pages → deploy from `main` / root.

## Rebuilding the vendored SDK

```
npm i firebase esbuild
npx esbuild vendor/entry.js --bundle --minify --format=esm --target=es2020 --outfile=vendor/firebase.js
```
