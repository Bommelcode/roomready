const sharp = require('sharp')
const fs = require('fs')

// Logitech-inspired icon: dark bg, blue ring, white camera + L shape
const size = 256
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a2a4a"/>
      <stop offset="100%" style="stop-color:#0d1929"/>
    </linearGradient>
    <linearGradient id="ring" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4a9eff"/>
      <stop offset="100%" style="stop-color:#1a6fd4"/>
    </linearGradient>
  </defs>
  <!-- Background circle -->
  <circle cx="128" cy="128" r="128" fill="url(#bg)"/>
  <!-- Blue ring -->
  <circle cx="128" cy="128" r="110" fill="none" stroke="url(#ring)" stroke-width="10"/>
  <!-- Camera body -->
  <rect x="58" y="88" width="118" height="82" rx="14" fill="white" opacity="0.95"/>
  <!-- Lens outer -->
  <circle cx="128" cy="129" r="28" fill="#1a6fd4"/>
  <!-- Lens inner -->
  <circle cx="128" cy="129" r="18" fill="#0a1e3a"/>
  <!-- Lens highlight -->
  <circle cx="120" cy="121" r="5" fill="white" opacity="0.4"/>
  <!-- Viewfinder top-right bump -->
  <rect x="158" y="78" width="18" height="14" rx="4" fill="white" opacity="0.95"/>
  <!-- Record dot -->
  <circle cx="75" cy="104" r="5" fill="#4a9eff"/>
</svg>`

sharp(Buffer.from(svg))
  .resize(256, 256)
  .png()
  .toFile('build/icon.png', (err) => {
    if (err) { console.error(err); process.exit(1) }
    console.log('icon.png created')
  })
