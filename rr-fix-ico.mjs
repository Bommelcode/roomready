// One-shot: regenereer icon.ico met PNG-encoded entries (electron-builder
// en moderne Windows verwachten dat, vooral voor 256×256). to-ico gebruikt
// DIB/BMP wat ervoor zorgt dat electron-builder stilletjes terugvalt op
// het default Electron-icoon.
import pngToIco from 'png-to-ico'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import url from 'url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const src = path.join(__dirname, 'icon.png')

const buffers = await Promise.all(sizes.map(s =>
  sharp(src).resize(s, s, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer()
))
const ico = await pngToIco(buffers)
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico)
console.log(`Wrote icon.ico (${(ico.length/1024).toFixed(1)} KB) with PNG entries at ${sizes.join(', ')}`)
