/**
 * Downloads the public-domain Neapolitan deck from Wikimedia Commons and
 * converts it to WebP in public/cards/.
 *
 * Run once with `npm run assets`. The output is committed, so the build never
 * touches the network.
 *
 * Source: https://commons.wikimedia.org/wiki/Category:Naples_deck
 * All 41 files are public domain (uploader: Trocche100, via it.wikipedia).
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cards')

/** Wikimedia asks for a descriptive User-Agent on automated requests. */
const USER_AGENT =
  'briscola-project/0.1 (https://github.com/; asset build script) node-fetch'

/** Width to render at. Cards display at most ~120 CSS px, so 420 covers 3x DPI. */
const WIDTH = 420
const QUALITY = 82

const SUITS = ['denari', 'coppe', 'spade', 'bastoni']

/**
 * The Commons files are numbered 01..40 and named with Italian numerals.
 * Ranks 8/9/10 are the Fante, Cavallo and Re, but the uploader named them
 * "Otto", "Nove" and "Dieci" — verified by eye, the art is correct.
 */
const NUMERALS = [
  'Asso', 'Due', 'Tre', 'Quattro', 'Cinque',
  'Sei', 'Sette', 'Otto', 'Nove', 'Dieci',
]

/**
 * Builds the exact Commons filename for card index `i` (1-based, 1..40).
 * Note file 40 is the one file in the set that capitalises the suit.
 */
function commonsName(i) {
  const suit = SUITS[Math.floor((i - 1) / 10)]
  const numeral = NUMERALS[(i - 1) % 10]
  const suitLabel = i === 40 ? 'Bastoni' : suit
  return `${String(i).padStart(2, '0')} ${numeral} di ${suitLabel}.jpg`
}

function filePathUrl(name) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${WIDTH}`
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Commons rate-limits automated thumbnail requests aggressively and answers
 * with 429. Back off and retry rather than losing the whole run.
 */
async function download(name, attempt = 1) {
  const res = await fetch(filePathUrl(name), { headers: { 'User-Agent': USER_AGENT } })

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) throw new Error(`${res.status} after ${attempt} attempts for "${name}"`)
    const wait = Math.min(60_000, 2 ** attempt * 1000)
    console.log(`    ${res.status} — backing off ${wait / 1000}s (attempt ${attempt})`)
    await sleep(wait)
    return download(name, attempt + 1)
  }

  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for "${name}"`)
  return Buffer.from(await res.arrayBuffer())
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function convert(buf, outName) {
  const out = join(OUT_DIR, outName)
  const info = await sharp(buf)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(out)
  return info.size
}

/** Fetch one card unless it is already on disk, so re-runs resume. */
async function fetchOne(commonsFile, outName) {
  if (await exists(join(OUT_DIR, outName))) {
    console.log(`  ${outName.padEnd(18)}  skip (already present)`)
    return 0
  }
  const size = await convert(await download(commonsFile), outName)
  console.log(`  ${outName.padEnd(18)} ${String(Math.round(size / 1024)).padStart(4)} KB   ← ${commonsFile}`)
  await sleep(1200) // stay under Commons' automated-request rate limit
  return size
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  let total = 0
  for (let i = 1; i <= 40; i++) {
    const suit = SUITS[Math.floor((i - 1) / 10)]
    const rank = ((i - 1) % 10) + 1
    total += await fetchOne(commonsName(i), `${suit}-${rank}.webp`)
  }
  total += await fetchOne('Carte Napoletane retro.jpg', 'back.webp')

  await writeFile(join(OUT_DIR, 'CREDITS.md'), CREDITS)

  console.log(`\n41 images, ${Math.round(total / 1024)} KB downloaded this run → public/cards/`)
}

const CREDITS = `# Card artwork credits

The 40 card faces and the card back in this directory come from the Wikimedia
Commons category [Naples deck](https://commons.wikimedia.org/wiki/Category:Naples_deck).

- **Source files:** \`01 Asso di denari.jpg\` … \`40 Dieci di Bastoni.jpg\`, plus
  \`Carte Napoletane retro.jpg\`
- **Uploader:** Trocche100, transferred from it.wikipedia to Commons
- **License:** **Public domain** — verified via the Commons API
  (\`extmetadata.LicenseShortName == "Public domain"\` on every file)

No attribution is legally required, but it is recorded here as a courtesy and so
the provenance stays traceable.

Regenerate with \`npm run assets\`. The originals are 1324×2188 JPEG; this
directory holds them downscaled to ${WIDTH}px wide and re-encoded as WebP.

## Rank mapping

Briscola uses a 40-card Italian deck. Ranks 8, 9 and 10 are the **Fante**
(jack), **Cavallo** (knight) and **Re** (king) — the Commons filenames call them
"Otto", "Nove" and "Dieci", but the artwork is the correct court card.
`

main().catch(err => {
  console.error(`\nAsset fetch failed: ${err.message}`)
  process.exit(1)
})
