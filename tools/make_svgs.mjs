// Writes icons/icon.svg and tools/_art.html from the qamariya artwork.
import { writeFileSync } from 'node:fs';
import { qamariya } from '../js/qamariya.js';
const style = `.frame{fill:#F7F1E6;stroke:#C9B497;stroke-width:1.5}.backing{fill:#2B1B12}.lattice{fill:none;stroke:#F7F1E6;stroke-width:3.2;stroke-linecap:round}.transom{fill:#F7F1E6}.pearls{fill:#7A4A2E;opacity:.55}.g{opacity:.95}.g.low{opacity:.4}`;
const inner = qamariya({ mood: 'even', variant: 'full' }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
// square icon: mud background, window centred
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>${style}</style>
<rect width="512" height="512" rx="112" fill="#7A4A2E"/>
<g transform="translate(131 76) scale(1.25)">${inner}</g></svg>`;
writeFileSync('icons/icon.svg', icon);
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>${style}</style>
<rect width="512" height="512" fill="#7A4A2E"/>
<g transform="translate(166 116) scale(0.9)">${inner}</g></svg>`;
writeFileSync('tools/_maskable.svg', maskable);
const fullSvg = qamariya({ mood: 'even', variant: 'full' }).replace('<svg ', `<svg style="width:250px;height:auto" `).replace('xmlns="http://www.w3.org/2000/svg">', `xmlns="http://www.w3.org/2000/svg"><style>${style}</style>`);
writeFileSync('tools/_og.html', `<!doctype html><html dir="rtl"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Reem+Kufi:wght@700&family=Fraunces:ital,opsz,wght@1,9..144,500&family=IBM+Plex+Sans+Arabic:wght@500&display=swap" rel="stylesheet">
<style>body{margin:0}.og{width:1200px;height:630px;background:#F3EBDD;display:flex;align-items:center;justify-content:center;gap:70px;position:relative;font-family:'IBM Plex Sans Arabic'}
.og:before{content:"";position:absolute;inset:0 0 auto 0;height:44px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='24'%3E%3Cpath d='M0 24 16 6l16 18Z' fill='%23F7F1E6'/%3E%3C/svg%3E") repeat-x bottom/32px 24px,#7A4A2E}
.og:after{content:"";position:absolute;inset:auto 0 0 0;height:20px;background:#7A4A2E}
h1{font:700 104px/1.1 'Reem Kufi';color:#7A4A2E;margin:0}p{margin:10px 0 0;font:italic 500 38px 'Fraunces';color:#6E5646;direction:ltr;text-align:right}.t{font-size:30px;color:#6E5646;margin-top:22px}</style></head>
<body><div class="og">${fullSvg}<div><h1>القطة ياعبدو</h1><p>Al-Gutta Ya Abdo</p><div class="t">حساب بسيط بينك وبين ربعك — يرجع صفر.</div></div></div></body></html>`);
console.log('svgs ok');
