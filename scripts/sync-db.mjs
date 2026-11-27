import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL =
  'https://raw.githubusercontent.com/clix-owner/Resources-Clix/main/anime_merged.json';

const DATA_DIR = path.resolve('data');
const ANIME_DIR = path.join(DATA_DIR, 'anime');
const MAPPINGS_PATH = path.join(DATA_DIR, 'mappings.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 50);

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

function decodeXml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function enrichFromANN(annId) {
  try {
    const res = await fetch(
      `https://cdn.animenewsnetwork.com/encyclopedia/api.xml?anime=${annId}`
    );
    if (!res.ok) return null;
    const xml = await res.text();

    const plotMatch = xml.match(/<info[^>]*type="Plot Summary"[^>]*>([\s\S]*?)<\/info>/);
    const picMatch = xml.match(/<info[^>]*type="Picture"[^>]*src="([^"]+)"/);

    const episodes = [];
    const epRegex = /<episode num="([^"]+)">\s*<title[^>]*>([\s\S]*?)<\/title>/g;
    let m;
    while ((m = epRegex.exec(xml)) !== null) {
      episodes.push({ number: m[1], title: decodeXml(m[2].trim()) });
    }

    const openings = [];
    const opRegex = /<info[^>]*type="Opening Theme"[^>]*>([\s\S]*?)<\/info>/g;
    while ((m = opRegex.exec(xml)) !== null) {
      openings.push(decodeXml(m[1].trim()));
    }

    const endings = [];
    const edRegex = /<info[^>]*type="Ending Theme"[^>]*>([\s\S]*?)<\/info>/g;
    while ((m = edRegex.exec(xml)) !== null) {
      endings.push(decodeXml(m[1].trim()));
    }

    return {
      synopsis: plotMatch ? decodeXml(plotMatch[1].trim()) : null,
      ann_picture: picMatch ? picMatch[1] : null,
      episodes_list: episodes,
      themes: { openings, endings },
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

  const indexList = [];
  let enrichedCount = 0;

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
    const detailPath = path.join(ANIME_DIR, `${exId}.json`);
    const existing = await readJson(detailPath, {});

    let enriched = existing._enriched ? {
      synopsis: existing.synopsis ?? null,
      ann_picture: existing.ann_picture ?? null,
      episodes_list: existing.episodes_list ?? [],
      themes: existing.themes ?? { openings: [], endings: [] },
      _enriched: true,
    } : null;

    if (!enriched && item.animenewsnetwork_id && enrichedCount < ENRICH_LIMIT) {
      const annData = await enrichFromANN(item.animenewsnetwork_id);
      if (annData) {
        enriched = { ...annData, _enriched: true };
        enrichedCount++;
      }
    }

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
  console.log(
    `Synced ${indexList.length} entries (enriched ${enrichedCount} via ANN). Max ex_id: ${maxExId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
