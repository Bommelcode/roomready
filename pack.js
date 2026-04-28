// Repack: dev-tree → ../resources/app.asar
// Usage: npm run pack
const asar = require('@electron/asar')
const path = require('path')
const fs = require('fs')

const src = __dirname
const dst = path.resolve(__dirname, '..', 'resources', 'app.asar')

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
  ]},
}).then(() => {
  const mb = (fs.statSync(dst).size / 1024 / 1024).toFixed(2)
  const v  = require('./package.json').version
  console.log(`Packed v${v} → ${dst} (${mb} MB)`)
}).catch(e => { console.error('Pack failed:', e.message); process.exit(1) })
