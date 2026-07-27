# Food Swap backend (transcription + vision)

A tiny app-owned proxy so the OpenAI key stays **server-side** and never ships inside the mobile
app. The app uploads audio / images here; this server calls OpenAI and returns the result.

| Endpoint | Body | Returns | Model |
|----------|------|---------|-------|
| `POST /transcribe` | `multipart/form-data`, field `audio` | `{ transcript }` | Whisper (`whisper-1`) |
| `POST /vision` | JSON `{ base64, mime }` | `{ analysis }` (FoodPhotoAnalysis JSON) | `gpt-4o-mini` vision |
| `GET /health` | — | `{ ok, hasKey }` | — |

## Run it (on your Mac, same Wi-Fi as the iPhone)

```bash
cd server
npm install
OPENAI_API_KEY=sk-your-key npm start      # listens on :8787
```

Find your Mac's LAN IP (`ipconfig getifaddr en0`), e.g. `192.168.1.50`, then in the **app project
root** create a `.env` (copy `.env.example`) with:

```
EXPO_PUBLIC_VOICE_ENDPOINT=http://192.168.1.50:8787/transcribe
EXPO_PUBLIC_VISION_ENDPOINT=http://192.168.1.50:8787/vision
```

Restart Metro so the new `EXPO_PUBLIC_*` values are picked up, then reload the dev build. Now:
- **Voice note** records → uploads to `/transcribe` → transcript → existing meal analysis → result.
- **Photo / Screenshot** auto-uploads to `/vision` → identifies the meal → result (or short
  follow-up chips when confidence is low).

No key is ever in the app bundle — only the public endpoint URLs.

## Notes
- Requires **Node 18+** (uses global `fetch` / `FormData` / `Blob`).
- Swap `TRANSCRIBE_MODEL=gpt-4o-transcribe` or `VISION_MODEL=gpt-4o` via env if you prefer.
- For production, deploy this behind HTTPS (e.g. a serverless function) and add auth/rate-limiting.
- `iOS` blocks plain `http://` by default; for a physical-device LAN test either use the dev
  scheme (Expo dev client allows local http) or run the server over https / a tunnel
  (`npx localtunnel --port 8787`).
