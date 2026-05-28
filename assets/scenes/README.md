# Scene Reference Images

**Phase 6.7.3 Owner-action blocker.** Until these files land, `processJob` falls back to text-only background generation (current behavior).

## Required files (one per Standard vibe)

| File | Vibe id | What to capture |
|---|---|---|
| `kopitiam.jpg` | `kopitiam` | White marble or formica table surface, fluorescent overhead lighting, traditional local kopitiam interior. |
| `cafe.jpg` | `cafe` | Light oak wood surface, warm natural window sunlight, modern aesthetic cafe vibes. |
| `street.jpg` | `street` | Stainless steel or dark asphalt surface, neon/streetlamp bokeh, night market energy. |
| `premium.jpg` | `premium` | Dark walnut or slate surface, diffused studio lighting, minimalist high-end restaurant feel. |

## Specs

- **One photo per vibe is enough for v1.** Photoroom's `background.guidance.imageFile` is a *style* reference (surface, lighting, palette, mood), not a composition reference — the food photo's own angle drives composition. A versatile ~45° angle works across both flatlay and angled food shots.
- **Format:** JPEG, compressed to ~50–100KB. Aim for ~1024px on the long edge.
- **Licensing:** must be owner-captured OR commercially licensed. Document the source in a sibling `LICENSES.md` if you add stock photos.

## How it's used

Backend caches these on module load (`server.js`). When a Standard-mode user picks a vibe AND `generateBackground === true`, the matching file is sent to Photoroom as `background.guidance.imageFile` alongside the LLM-generated `background.prompt`. Missing files fall through silently (text-only mode) — no crash.

The frontend also reads `../snapit-frontend/src/assets/scenes/{vibe}.jpg` for the 2×2 vibe-selector thumbnails. Keep both directories in sync.
