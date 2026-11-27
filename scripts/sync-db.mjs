import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL =
  'https://raw.githubusercontent.com/clix-owner/Resources-Clix/main/anime_merged.json';

const DATA_DIR = path.resolve('data');
const ANIME_DIR = path.join(DATA_DIR, 'anime');
const MAPPINGS_PATH = path.join(DATA_DIR, 'mappings.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getShard(exId) {
  return Math.ceil(exId / 10000);
}

async function enrichFromWikidata(title) {
  if (!title) return null;
  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
      title
    )}&language=en&format=json&limit=1`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'EnterXeraBot/1.0 (https://enterxera.com)' },
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const entity = searchData?.search?.[0];
    if (!entity?.id) return null;

    const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${entity.id}.json`;
    const entityRes = await fetch(entityUrl, {
      headers: { 'User-Agent': 'EnterXeraBot/1.0 (https://enterxera.com)' },
    });
    if (!entityRes.ok) return null;
    const entityData = await entityRes.json();
    const claims = entityData?.entities?.[entity.id]?.claims;
    const officialUrl = claims?.P856?.[0]?.mainsnak?.datavalue?.value ?? null;

    return {
      wikidata_id: entity.id,
      official_url: officialUrl,
      description: entity.description ?? null,
    };
  } catch {
    return null;
  }
}

async function main() {
  await fs.mkdir(ANIME_DIR, { recursive: true });

  console.log('Fetching upstream anime_merged.json...');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch source: ${res.status} ${res.statusText}`);
  }
  const upstream = await res.json();
  console.log(`Loaded ${upstream.length} anime entries.`);

  const mappings = await readJson(MAPPINGS_PATH, {});
  const reverseByMal = new Map();
  const reverseByAnilist = new Map();
  let maxExId = 0;

  for (const [exIdStr, map] of Object.entries(mappings)) {
    const exId = Number(exIdStr);
    if (exId > maxExId) maxExId = exId;
    if (map.mal_id) reverseByMal.set(map.mal_id, exId);
    if (map.anilist_id) reverseByAnilist.set(map.anilist_id, exId);
  }

  const indexList = new Array(upstream.length);
  let enrichedCount = 0;
  let skippedCount = 0;
  let processedCount = 0;

  async function processItem(item, idx) {
    let exId =
      (item.mal_id && reverseByMal.get(item.mal_id)) ||
      (item.anilist_id && reverseByAnilist.get(item.anilist_id));

    if (!exId) {
      maxExId += 1;
      exId = maxExId;
    }

    const shard = getShard(exId);
    const mediaBase = `https://cdn.jsdelivr.net/gh/enterxera/enterxera-media-${shard}@main`;
    const detailPath = path.join(ANIME_DIR, `${exId}.json`);
    const existing = await readJson(detailPath, {});

    let enriched = null;
    if (existing._wikidata_enriched) {
      skippedCount++;
      enriched = {
        wikidata_id: existing.wikidata_id ?? null,
        official_url: existing.official_url ?? null,
        description: existing.description ?? null,
        _wikidata_enriched: true,
      };
    } else if (enrichedCount < ENRICH_LIMIT) {
      enrichedCount++;
      const title = item.title_english || item.title_romaji;
      const wd = await enrichFromWikidata(title);
      if (wd) {
        enriched = { ...wd, _wikidata_enriched: true };
      }
    }

    mappings[String(exId)] = {
      ex_id: exId,
      mal_id: item.mal_id ?? null,
      anilist_id: item.anilist_id ?? null,
      themoviedb_id: item.themoviedb_id ?? null,
      tvdb_id: item.tvdb_id ?? null,
      imdb_id: item.imdb_id ?? null,
      animenewsnetwork_id: item.animenewsnetwork_id ?? null,
      wikidata_id: enriched?.wikidata_id ?? existing.wikidata_id ?? null,
      official_url: enriched?.official_url ?? existing.official_url ?? null,
    };

    const detail = {
      ex_id: exId,
      ...item,
      ...(enriched || {}),
      media: {
        poster: `${mediaBase}/posters/${exId}.webp`,
        banner: `${mediaBase}/banners/${exId}.webp`,
        backdrop: `${mediaBase}/backdrops/${exId}.webp`,
        logo: `${mediaBase}/logos/${exId}.png`,
      },
    };

    await fs.writeFile(detailPath, JSON.stringify(detail));

    indexList[idx] = {
      ex_id: exId,
      title_romaji: item.title_romaji ?? null,
      title_english: item.title_english ?? null,
      title_native: item.title_native ?? null,
      format: item.format ?? item.type ?? null,
      category: item.category ?? null,
      status: item.status ?? null,
      episodes: item.episodes ?? null,
      air_date: item.air_date ?? null,
      poster: detail.media.poster,
    };

    processedCount++;
    if (processedCount % 100 === 0 || processedCount === upstream.length) {
      console.log(
        `[Progress] ${processedCount}/${upstream.length} | Enriched: ${enrichedCount} | Skipped: ${skippedCount}`
      );
    }
  }

  for (let i = 0; i < upstream.length; i += CONCURRENCY) {
    const batch = upstream.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((item, offset) => processItem(item, i + offset)));
  }

  await fs.writeFile(MAPPINGS_PATH, JSON.stringify(mappings, null, 2));
  await fs.writeFile(INDEX_PATH, JSON.stringify(indexList));
  console.log(
    `Done! Synced ${indexList.length} entries (Enriched: ${enrichedCount}, Skipped: ${skippedCount}). Max ex_id: ${maxExId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
