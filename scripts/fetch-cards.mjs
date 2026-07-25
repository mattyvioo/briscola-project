/**
 * Downloads the card artwork for every deck style and writes it to
 * public/cards/<deck>/<suit>-<rank>.webp.
 *
 * Run once with `npm run assets`. Output is committed, so the build never
 * touches the network. Existing files are skipped, so a rate-limited run can
 * simply be re-run.
 *
 * Decks:
 *   napoletane   Wikimedia Commons "Naples deck"        public domain
 *   bergamasche  Wikimedia Commons "Bergamo deck"       CC BY-SA 3.0 (Poulpy)
 *   francesi     Commons "English pattern ... deck.svg" CC0
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cards')

/** Wikimedia asks for a descriptive User-Agent on automated requests. */
const USER_AGENT = 'briscola-project/0.1 (card asset build script) node-fetch'

/** Cards render at most ~120 CSS px wide, so 420 covers 3x DPI. */
const WIDTH = 420
const QUALITY = 82

const SUITS = ['denari', 'coppe', 'spade', 'bastoni']
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Commons rate-limits automated requests hard; back off rather than lose the run. */
async function download(name, attempt = 1) {
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 12) throw new Error(`${res.status} after ${attempt} attempts for "${name}"`)
    // Commons' limiter stays angry for a while once tripped, so cap the backoff
    // high rather than giving up early. The run is resumable either way.
    const wait = Math.min(120_000, 2 ** attempt * 1000)
    console.log(`    ${res.status} — backing off ${wait / 1000}s`)
    await sleep(wait)
    return download(name, attempt + 1)
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for "${name}"`)
  return Buffer.from(await res.arrayBuffer())
}

async function writeWebp(pipeline, outPath) {
  const info = await pipeline.webp({ quality: QUALITY }).toFile(outPath)
  return info.size
}

// ---------------------------------------------------------------------------
// napoletane — 40 separate public-domain scans, plus the shared card back
// ---------------------------------------------------------------------------

const NUMERALS = [
  'Asso', 'Due', 'Tre', 'Quattro', 'Cinque',
  'Sei', 'Sette', 'Otto', 'Nove', 'Dieci',
]

function napoletaneFile(i) {
  const suit = SUITS[Math.floor((i - 1) / 10)]
  // File 40 is the one file in the set that capitalises the suit.
  const suitLabel = i === 40 ? 'Bastoni' : suit
  return `${String(i).padStart(2, '0')} ${NUMERALS[(i - 1) % 10]} di ${suitLabel}.jpg`
}

async function buildNapoletane(dir) {
  let total = 0
  for (let i = 1; i <= 40; i++) {
    const suit = SUITS[Math.floor((i - 1) / 10)]
    const rank = ((i - 1) % 10) + 1
    const out = join(dir, `${suit}-${rank}.webp`)
    if (await exists(out)) continue
    const buf = await download(napoletaneFile(i))
    total += await writeWebp(sharp(buf).resize({ width: WIDTH, withoutEnlargement: true }), out)
    console.log(`  napoletane/${suit}-${rank}`)
    await sleep(3000)
  }
  return total
}

// ---------------------------------------------------------------------------
// bergamasche — 40 separate files, Italian-suited northern pattern
// ---------------------------------------------------------------------------

const BERGAMO_SUIT = { denari: 'Coins', coppe: 'Cups', spade: 'Swords', bastoni: 'Wands' }
const BERGAMO_RANK = { 1: 'Ace', 8: 'Jack', 9: 'Knight', 10: 'King' }

function bergamascheFile(suit, rank) {
  const r = BERGAMO_RANK[rank] ?? String(rank).padStart(2, '0')
  return `Bergamo Deck - ${BERGAMO_SUIT[suit]} - ${r}.jpg`
}

async function buildBergamasche(dir) {
  let total = 0
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const out = join(dir, `${suit}-${rank}.webp`)
      if (await exists(out)) continue
      const buf = await download(bergamascheFile(suit, rank))
      // Sources are only 300px wide; upscaling would just blur them.
      total += await writeWebp(sharp(buf).resize({ width: WIDTH, withoutEnlargement: true }), out)
      console.log(`  bergamasche/${suit}-${rank}`)
      await sleep(3000)
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// francesi — one CC0 SVG holding a 13x4 grid, sliced into cards
// ---------------------------------------------------------------------------

const FRENCH_SHEET = 'English pattern playing cards deck.svg'
/** Sheet rows are spades, hearts, diamonds, clubs — the usual Italian mapping. */
const FRENCH_ROW = { spade: 0, coppe: 1, denari: 2, bastoni: 3 }
/** Columns run A,2..10,J,Q,K. Briscola's 8/9/10 are the Jack/Queen/King. */
const FRENCH_COL = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 10, 9: 11, 10: 12 }

/**
 * Finds the card inside a grid cell.
 *
 * The sheet paints white cards on a flat green field. Chroma-keying the green
 * is not safe — the court cards contain green of their own — so instead scan
 * in from each edge for the first row/column that is not background, then mask
 * the rounded corners, which is the only place background survives the crop.
 */
async function cropCard(cellBuf, background) {
  const { data, info } = await sharp(cellBuf).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const at = (x, y) => {
    const i = (y * info.width + x) * ch
    return [data[i], data[i + 1], data[i + 2]]
  }
  // The background colour is sampled once from the whole sheet rather than
  // per cell: some cards sit flush against their cell edge, so a corner pixel
  // would sample the card itself and the scan would then "trim" the white
  // card face away.
  const [br, bg, bb] = background
  const isBg = (x, y) => {
    const [r, g, b] = at(x, y)
    return Math.abs(r - br) < 40 && Math.abs(g - bg) < 40 && Math.abs(b - bb) < 40
  }
  const rowIsBg = y => {
    for (let x = 0; x < info.width; x++) if (!isBg(x, y)) return false
    return true
  }
  const colIsBg = x => {
    for (let y = 0; y < info.height; y++) if (!isBg(x, y)) return false
    return true
  }

  let top = 0, bottom = info.height - 1, left = 0, right = info.width - 1
  while (top < bottom && rowIsBg(top)) top++
  while (bottom > top && rowIsBg(bottom)) bottom--
  while (left < right && colIsBg(left)) left++
  while (right > left && colIsBg(right)) right--

  // Step in one more pixel all round: the card edge is anti-aliased against
  // the green, and that blend fringe is what shows as a faint halo.
  top += 1
  bottom -= 1
  left += 1
  right -= 1

  const width = right - left + 1
  const height = bottom - top + 1

  // Crop and resize in their own pass, *then* mask.
  //
  // Sharp runs a fixed internal pipeline (resize happens before composite)
  // regardless of the order the calls are chained, so masking and resizing in
  // one chain compares the mask against the already-shrunk image and fails
  // with "Image to composite must have same dimensions or smaller".
  const resized = await sharp(cellBuf)
    .extract({ left, top, width, height })
    .resize({ width: WIDTH, withoutEnlargement: true })
    .png()
    .toBuffer()

  const meta = await sharp(resized).metadata()
  const w = meta.width
  const h = meta.height

  // Knock out the rounded corners so no green shows around the card edge.
  // The mask is rasterised to exact pixels because librsvg scales by DPI.
  const radius = Math.round(w * 0.055)
  const mask = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
    ),
  )
    .resize(w, h, { fit: 'fill' })
    .png()
    .toBuffer()

  return sharp(resized).composite([{ input: mask, blend: 'dest-in' }])
}

async function buildFrancesi(dir) {
  const needed = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (!(await exists(join(dir, `${suit}-${rank}.webp`)))) needed.push([suit, rank])
    }
  }
  if (needed.length === 0) return 0

  // The sheet is one 2.5 MB file that gets sliced into all 40 cards. Cache it
  // so a re-run (or a rate-limited Commons) doesn't have to fetch it again.
  const cachePath = join(OUT_ROOT, '..', '..', '.assetcache', 'french.svg')
  let svg
  if (await exists(cachePath)) {
    console.log('  using cached sheet')
    svg = await readFile(cachePath)
  } else {
    console.log('  fetching the CC0 sheet…')
    svg = await download(FRENCH_SHEET)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, svg)
  }
  // Rasterise the whole sheet once, generously oversized, then slice.
  const sheet = await sharp(svg, { density: 300 }).resize({ width: 13 * 460 }).png().toBuffer()
  const meta = await sharp(sheet).metadata()
  const cw = meta.width / 13
  const chh = meta.height / 4

  // The sheet's very first pixel is always the green field around the cards.
  const probe = await sharp(sheet).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
  const background = [probe[0], probe[1], probe[2]]

  let total = 0
  for (const [suit, rank] of needed) {
    const cell = await sharp(sheet)
      .extract({
        left: Math.round(FRENCH_COL[rank] * cw),
        top: Math.round(FRENCH_ROW[suit] * chh),
        width: Math.floor(cw),
        height: Math.floor(chh),
      })
      .png()
      .toBuffer()
    total += await writeWebp(await cropCard(cell, background), join(dir, `${suit}-${rank}.webp`))
    console.log(`  francesi/${suit}-${rank}`)
  }
  return total
}

// ---------------------------------------------------------------------------

const CREDITS = `# Card artwork credits

Each subdirectory is one deck style, selectable in the game's settings.

## \`napoletane/\` — Neapolitan pattern

Wikimedia Commons, [Naples deck](https://commons.wikimedia.org/wiki/Category:Naples_deck).
Files \`01 Asso di denari.jpg\` … \`40 Dieci di Bastoni.jpg\`, uploader **Trocche100**.
**Public domain** (verified via the Commons API).

## \`bergamasche/\` — Bergamo pattern (northern, Italian-suited)

Wikimedia Commons, [Bergamo deck](https://commons.wikimedia.org/wiki/Category:Bergamo_deck).
Files \`Bergamo Deck - <suit> - <rank>.jpg\`, author **Poulpy**.
**CC BY-SA 3.0** — attribution required, and modified copies (these are resized
and re-encoded) stay under the same licence.

## \`francesi/\` — French/English pattern

Wikimedia Commons,
[English pattern playing cards deck.svg](https://commons.wikimedia.org/wiki/File:English_pattern_playing_cards_deck.svg).
**CC0** (public domain dedication). Sliced out of the 13x4 sheet by
\`scripts/fetch-cards.mjs\`.

## \`back.webp\` — shared card back

\`Carte Napoletane retro.jpg\` from the Naples deck category, **public domain**.
Used by every deck style.

---

Rank mapping: Briscola uses a 40-card deck where ranks 8, 9 and 10 are the
**Fante**, **Cavallo** and **Re**. In the French deck those are the Jack, Queen
and King.

Regenerate with \`npm run assets\`.
`

async function main() {
  // Ordered cheapest-first in requests. `francesi` is a single file that gets
  // sliced locally; `bergamasche` needs 40 separate fetches and reliably trips
  // Commons' rate limiter, so it goes last — a stall there should not stop the
  // other decks from being built.
  const decks = [
    ['francesi', buildFrancesi],
    ['napoletane', buildNapoletane],
    ['bergamasche', buildBergamasche],
  ]

  let total = 0
  const failed = []
  for (const [id, build] of decks) {
    const dir = join(OUT_ROOT, id)
    await mkdir(dir, { recursive: true })
    console.log(`\n${id}:`)
    try {
      total += await build(dir)
    } catch (err) {
      // Resumable: re-running picks up where this left off.
      console.error(`  ${id} incomplete — ${err.message}`)
      failed.push(id)
    }
  }

  const back = join(OUT_ROOT, 'back.webp')
  if (!(await exists(back))) {
    const buf = await download('Carte Napoletane retro.jpg')
    total += await writeWebp(sharp(buf).resize({ width: WIDTH, withoutEnlargement: true }), back)
    console.log('\nback.webp')
  }

  await writeFile(join(OUT_ROOT, 'CREDITS.md'), CREDITS)
  console.log(`\nDone. ${Math.round(total / 1024)} KB written this run.`)
  if (failed.length > 0) {
    console.log(`Incomplete: ${failed.join(', ')} — re-run to resume.`)
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`\nAsset fetch failed: ${err.message}`)
  process.exit(1)
})
