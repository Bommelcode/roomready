// Repack: dev-tree → ../resources/app.asar + helpers/ outside the asar.
// Usage: npm run pack
const asar = require('@electron/asar')
const path = require('path')
const fs = require('fs')

const src = __dirname
const dst = path.resolve(__dirname, '..', 'resources', 'app.asar')

// Native .exe's kunnen niet vanuit een asar gespawned worden (Electron mount
// asar als virtual fs, child_process.execFile heeft een echte file-handle nodig).
// We mirroren daarom de helpers/-map naar ../helpers/ — naast resources/, op
// dezelfde laag als RoomReady.exe. main.js zoekt 'm daar via process.resourcesPath.
const helpersSrc = path.join(__dirname, 'helpers')
const helpersDst = path.resolve(__dirname, '..', 'helpers')

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return 0
  fs.mkdirSync(dstDir, { recursive: true })
  let n = 0
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name)
    const d = path.join(dstDir, entry.name)
    if (entry.isDirectory()) { n += copyDir(s, d); continue }
    // .cs bronbestanden hoeven niet mee — alleen runtime artefacten.
    if (entry.name.endsWith('.cs')) continue
    fs.copyFileSync(s, d)
    n++
  }
  return n
}

asar.createPackageWithOptions(src, dst, {
  globOptions: { dot: true, ignore: [
    '**/node_modules/**',
    '**/.node/**',
    '**/.snapshots/**',
    '**/.claude/**',
    '**/.git/**',
    '**/.gitignore',
    '**/package-lock.json',
    '**/pack.js',
    '**/README.md',
    '**/dist/**',     // electron-builder output — niet meepacken (kan honderden MB zijn)
    '**/helpers/**',  // helpers/ wordt apart gemirrord naast app.asar (zie hieronder)
  ]},
}).then(() => {
  const mb = (fs.statSync(dst).size / 1024 / 1024).toFixed(2)
  const v  = require('./package.json').version
  const helperCount = copyDir(helpersSrc, helpersDst)
  console.log(`Packed v${v} → ${dst} (${mb} MB)`)
  console.log(`Mirrored ${helperCount} helper file(s) → ${helpersDst}`)
}).catch(e => { console.error('Pack failed:', e.message); process.exit(1) })
