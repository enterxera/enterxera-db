import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL =
  'https://raw.githubusercontent.com/clix-owner/Resources-Clix/main/anime_merged.json';

const DATA_DIR = path.resolve('data');
const ANIME_DIR = path.join(DATA_DIR, 'anime');
const MAPPINGS_PATH = path.join(DATA_DIR, 'mappings.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

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

  const indexList = [];

  for (const item of upstream) {
    let exId =
      (item.mal_id && reverseByMal.get(item.mal_id)) ||
      (item.anilist_id && reverseByAnilist.get(item.anilist_id));

    if (!exId) {
      maxExId += 1;
      exId = maxExId;
    }

    mappings[String(exId)] = {
      ex_id: exId,
      mal_id: item.mal_id ?? null,
      anilist_id: item.anilist_id ?? null,
      themoviedb_id: item.themoviedb_id ?? null,
      tvdb_id: item.tvdb_id ?? null,
      imdb_id: item.imdb_id ?? null,
      animenewsnetwork_id: item.animenewsnetwork_id ?? null,
      kitsu_id: item.kitsu_id ?? null,
      anidb_id: item.anidb_id ?? null,
    };

    const shard = getShard(exId);
    const mediaBase = `https://cdn.jsdelivr.net/gh/enterxera/enterxera-media-${shard}@main`;

    const detail = {
      ex_id: exId,
      ...item,
      media: {
        poster: `${mediaBase}/posters/${exId}.webp`,
        banner: `${mediaBase}/banners/${exId}.webp`,
        backdrop: `${mediaBase}/backdrops/${exId}.webp`,
        logo: `${mediaBase}/logos/${exId}.png`,
      },
    };

    await fs.writeFile(
      path.join(ANIME_DIR, `${exId}.json`),
      JSON.stringify(detail)
    );

    indexList.push({
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
    });
  }

  await fs.writeFile(MAPPINGS_PATH, JSON.stringify(mappings, null, 2));
  await fs.writeFile(INDEX_PATH, JSON.stringify(indexList));
  console.log(`Synced ${indexList.length} entries. Max ex_id: ${maxExId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
