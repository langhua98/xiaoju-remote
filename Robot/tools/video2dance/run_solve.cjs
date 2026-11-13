const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [, , poseFile, solveFile, outFile] = process.argv;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 300, height: 300 } });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://127.0.0.1:8123/index.html?demo=0&fidget=0&spring=0');
  await p.waitForFunction(() => window.YunlaiFace && YunlaiFace.get().loaded, null, { timeout: 180000 });
  await p.evaluate((d) => { window.__POSE = d; }, JSON.parse(fs.readFileSync(poseFile, 'utf8')));
  const res = await p.evaluate(fs.readFileSync(solveFile, 'utf8'));
  fs.writeFileSync(outFile, JSON.stringify(res));
  console.log('bones', Object.keys(res.bones).length, 'frames', res.frames, 'bytes', fs.statSync(outFile).size, 'root y range', Math.min(...res.root.filter((_, i) => i % 3 === 1)).toFixed(3), Math.max(...res.root.filter((_, i) => i % 3 === 1)).toFixed(3));
  await b.close();
})();
