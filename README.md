# enterxera-db

Static anime metadata & canonical `ex_id` mapping database for **EnterXera**, served via jsDelivr CDN.

## Structure
- `data/mappings.json` — Canonical `ex_id` to external IDs (`mal_id`, `anilist_id`, `themoviedb_id`, `tvdb_id`, `animenewsnetwork_id`, `imdb_id`)
- `data/index.json` — Lightweight catalog index for instant search, filtering, and pagination
- `data/anime/{ex_id}.json` — Full per-anime metadata
- `scripts/sync-db.mjs` — Automated sync script pulling from `clix-owner/Resources-Clix`
