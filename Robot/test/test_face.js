// Yunlai 面部动画链路测试：启动 face_server.py → 浏览器打开两个页面 → 从终端发指令 → 检查页面状态。
// 用法：node Robot/test/test_face.js            （需要 playwright）
//       SHOTS=/某个目录 node Robot/test/test_face.js   顺便把每个状态截图存下来
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18765 + Math.floor(Math.random() * 1000);
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(ok, what) { console.log((ok ? '  通过 ' : '  失败 ') + what); if (!ok) failed++; }

(async () => {
  const srv = spawn('python3', [path.join(__dirname, '..', 'face_server.py'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const say = (line) => srv.stdin.write(line + '\n');
  await sleep(800);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  for (const kind of ['face', 'avatar']) {
    console.log('\n[' + kind + ']');
    const page = await browser.newPage({ viewport: { width: 414, height: 736 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/${kind}/?ws=auto&debug=1`);
    const get = () => page.evaluate(() => window.YunlaiFace && window.YunlaiFace.get());
    if (kind === 'avatar') {
      await page.waitForFunction(() => window.YunlaiFace && window.YunlaiFace.get().loaded, null, { timeout: 60000 });
      check(true, '模型加载完成');
    }
    await page.waitForFunction(() => window.YunlaiFace.get().link === 'online', null, { timeout: 10000 });
    check(true, 'WebSocket 已连接');
    await sleep(2500);

    const cases = [
      ['listening', (g) => g.state === 'listening'],
      ['thinking', (g) => g.state === 'thinking'],
      ['speaking happy', (g) => g.state === 'speaking' && g.emotion === 'happy' && g.mouth > 0.02],
      ['observing neutral', (g) => g.state === 'observing' && g.emotion === 'neutral'],
      ['gimbal -30', (g) => g.gaze.x < -0.4],
      ['event anomaly', (g) => g.emotion === 'alert'],
      ['idle surprised', (g) => g.state === 'idle' && g.emotion === 'surprised'],
      ['thinking confused', (g) => g.emotion === 'confused'],
      ['idle neutral', (g) => g.state === 'idle' && g.emotion === 'neutral'],
    ];
    for (const [cmd, ok] of cases) {
      say(cmd);
      await sleep(cmd.startsWith('gimbal') ? 1500 : 1200);
      const g = await get();
      check(ok(g), cmd + ' → ' + g.state + '/' + g.emotion);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, kind + '-' + cmd.replace(/\s+/g, '_') + '.png') });
    }
    say('{"type":"robot_state","state":"speaking","mouth_level":0.8}');
    await sleep(300);
    check((await get()).mouth > 0.5, 'mouth_level 0.8 驱动嘴型');

    say('speaking');
    await sleep(600);
    srv.stdin.write('');
    check(errors.length === 0, '没有脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
    await page.close();
  }

  // 断线回退：服务器关掉后页面应回到待机
  const page = await browser.newPage({ viewport: { width: 736, height: 414 } });
  await page.goto(`http://127.0.0.1:${PORT}/face/?ws=auto`);
  await page.waitForFunction(() => window.YunlaiFace.get().link === 'online');
  say('speaking happy');
  await sleep(500);
  srv.kill();
  await page.waitForFunction(() => window.YunlaiFace.get().link === 'offline', null, { timeout: 5000 });
  const g = await page.evaluate(() => window.YunlaiFace.get());
  console.log('\n[断线]');
  check(g.state === 'idle' && g.emotion === 'neutral', '断线后回到待机');

  await browser.close();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
