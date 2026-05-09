// One-shot: AI-gegenereerde PNG heeft schaakbord-patroon ingebakken (geen
// echte alpha). Strip background via saturation-key, crop, square-pad,
// genereer multi-resolution ICO.
// Run: node rr-make-icon.mjs <source.png>
import sharp from 'sharp'
import toIco from 'to-ico'
import fs from 'fs'
import path from 'path'
import url from 'url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const src = process.argv[2]
if (!src || !fs.existsSync(src)) {
  console.error('Usage: node rr-make-icon.mjs <source.png>'); process.exit(1)
}

// Stap 1: lees raw RGBA
const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width, H = info.height, CH = info.channels

// Stap 2: bepaal background-pixels via saturatie + helderheid
// Het schaakbord = pure grijs (205,205,205) en wit (255,255,255) — beide
// hebben sat=0. Het ronde-vierkant heeft duidelijk gekleurde pixels
// (blauw/groen). Threshold sat<15 = grijs/wit checker; brightness>180 zorgt
// dat we donkere icoon-elementen niet per ongeluk mee transparant maken.
function isBackground(r, g, b) {
  const sat = Math.max(r, g, b) - Math.min(r, g, b)
  const brightness = (r + g + b) / 3
  return sat < 15 && brightness > 180
}

// Stap 3: bounding box van NIET-background pixels = ronde-vierkant
let minX = W, minY = H, maxX = -1, maxY = -1
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * CH
    if (!isBackground(data[i], data[i+1], data[i+2])) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
}
if (maxX < 0) { console.error('Geen icon-pixels gevonden'); process.exit(1) }
const cw = maxX - minX + 1, ch = maxY - minY + 1
console.log(`Source ${W}×${H} → icon bbox ${cw}×${ch} (offset ${minX},${minY})`)

// Stap 4: maak transparant masker — voor elke pixel binnen bbox, zet alpha=0
// als 't background is, anders houd 255. Result: rounded-square op transparant.
const out = Buffer.alloc(cw * ch * 4)
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const srcI = ((y + minY) * W + (x + minX)) * CH
    const dstI = (y * cw + x) * 4
    const r = data[srcI], g = data[srcI+1], b = data[srcI+2]
    out[dstI]     = r
    out[dstI + 1] = g
    out[dstI + 2] = b
    out[dstI + 3] = isBackground(r, g, b) ? 0 : 255
  }
}
const cleaned = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer()

// Stap 5: vierkant maken (transparant gepad)
const size = Math.max(cw, ch)
const padX = Math.floor((size - cw) / 2)
const padY = Math.floor((size - ch) / 2)
const squared = await sharp(cleaned).extend({
  top: padY, bottom: size - ch - padY,
  left: padX, right: size - cw - padX,
  background: { r: 0, g: 0, b: 0, alpha: 0 },
}).png().toBuffer()
console.log(`Squared: ${size}×${size}`)

// Stap 6: multi-resolution ICO + 512px PNG
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const pngs = await Promise.all(ICO_SIZES.map(sz =>
  sharp(squared).resize(sz, sz, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer()
))
const ico = await toIco(pngs)
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico)
const icon512 = await sharp(squared).resize(512, 512, { kernel: 'lanczos3' }).png().toBuffer()
fs.writeFileSync(path.join(__dirname, 'icon.png'), icon512)
console.log(`Wrote icon.ico (${(ico.length/1024).toFixed(1)} KB, ${ICO_SIZES.length} resoluties) and icon.png (${(icon512.length/1024).toFixed(1)} KB)`)
