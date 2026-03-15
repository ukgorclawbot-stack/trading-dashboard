const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 5174;
const LOG_FILE = '/tmp/polymarket-auto.log';
const BOT_DIR = '/Users/ukgorclawbot/Desktop/polymarket-btc-5m';

// Cache balance for 30s to avoid spamming
let balanceCache = { value: null, ts: 0 };

function getBalance() {
  if (Date.now() - balanceCache.ts < 30000 && balanceCache.value) {
    return balanceCache.value;
  }
  try {
    const out = execSync('node index.mjs balance 2>&1', {
      cwd: BOT_DIR,
      timeout: 10000,
      encoding: 'utf-8'
    });
    const m = out.match(/USDC 余额: \$([\d.]+)/);
    if (m) {
      balanceCache = { value: m[1], ts: Date.now() };
      return m[1];
    }
  } catch (e) { /* ignore */ }
  return balanceCache.value || '—';
}

function isBotRunning() {
  try {
    const out = execSync('pgrep -f "polymarket-btc-5m" 2>/dev/null', { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch { return false; }
}

function parseLog() {
  if (!fs.existsSync(LOG_FILE)) return [];

  const log = fs.readFileSync(LOG_FILE, 'utf-8');
  const trades = [];

  // Split into trade blocks by "新窗口" (new window) markers
  const blocks = log.split(/(?=\[自动策略\] 新窗口)/);

  for (const block of blocks) {
    // Extract window timestamp
    const windowMatch = block.match(/\[自动策略\] 新窗口: (\d+) \((\d{4}-\d{2}-\d{2}T[\d:]+\.\d+Z)\)/);
    if (!windowMatch) continue;

    const windowId = windowMatch[1];
    const isoTime = windowMatch[2];
    const ts = new Date(isoTime);
    // Format as local time string
    const pad = n => String(n).padStart(2, '0');
    const tsStr = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

    // Extract strategy
    let strategy = 'unknown';
    if (block.includes('[过度自信反转]')) strategy = 'overconfidence-reversal';
    else if (block.includes('[趋势跟随]')) strategy = 'trend-follow';
    else if (block.includes('[低波动反转]')) strategy = 'low-vol-reversal';
    else if (block.includes('[跳过]') || block.includes('无明确信号')) {
      continue; // skipped trade
    }

    // Extract order direction and amount
    const orderMatch = block.match(/\[下单\] 方向=(UP|DOWN), 金额=\$([\d.]+)/);
    if (!orderMatch) continue;

    const dir = orderMatch[1];
    const amount = parseFloat(orderMatch[2]);

    // Extract UP/DOWN prices from market info
    let upPrice = '0.50', downPrice = '0.50';
    const upPriceMatch = block.match(/UP\s+价格: \$([\d.]+)/);
    const downPriceMatch = block.match(/DOWN\s*价格: \$([\d.]+)/);
    if (upPriceMatch) upPrice = upPriceMatch[1];
    if (downPriceMatch) downPrice = downPriceMatch[1];

    // Check order result
    const successMatch = block.match(/\[成功\] 状态: (\w+)/);
    const orderIdMatch = block.match(/\[成功\] 订单ID: (0x[\da-f]+)/i);
    const failMatch = block.match(/\[失败\]/) || block.match(/\[错误\]/);

    if (failMatch && !successMatch) continue; // failed to place order

    // Determine trade result from Redeem lines in the ENTIRE log
    // Look for redeem of this windowId
    let result = 'pending';
    let pnl = 0;

    // Search full log for redeem of this market
    const redeemPattern = new RegExp(`\\[Redeem\\] btc-updown-5m-${windowId}: UP=(\\d+), DOWN=(\\d+)`);
    const redeemMatch = log.match(redeemPattern);
    if (redeemMatch) {
      const upShares = parseInt(redeemMatch[1]);
      const downShares = parseInt(redeemMatch[2]);
      // If we bought UP and UP has shares redeemed → won
      // If we bought UP and DOWN has shares redeemed → lost (but we wouldn't have DOWN shares)
      // Actually: redeem shows OUR positions being redeemed
      if (dir === 'UP' && upShares > 0) {
        result = 'won';
        // Approximate PnL: shares redeemed are in raw units (6 decimals for USDC)
        const redeemed = upShares / 1e6;
        pnl = redeemed - amount;
      } else if (dir === 'DOWN' && downShares > 0) {
        result = 'won';
        const redeemed = downShares / 1e6;
        pnl = redeemed - amount;
      } else if (dir === 'UP' && upShares === 0 && downShares === 0) {
        // No shares to redeem — likely lost
        result = 'lost';
        pnl = -amount;
      } else if (dir === 'DOWN' && downShares === 0 && upShares === 0) {
        result = 'lost';
        pnl = -amount;
      }
    }

    // If the order was matched but no redeem yet, check the takingAmount from result JSON
    if (result === 'pending') {
      const takingMatch = block.match(/"takingAmount":\s*"([\d.]+)"/);
      if (takingMatch) {
        // takingAmount is the number of outcome tokens we received
        // We'll know win/loss once market resolves
      }
    }

    trades.push({
      ts: tsStr,
      dir,
      amount,
      result,
      pnl: Math.round(pnl * 100) / 100,
      strategy,
      upPrice,
      downPrice,
      orderId: orderIdMatch ? orderIdMatch[1] : null,
    });
  }

  return trades.reverse(); // newest first
}

function getMarketPrices(trades) {
  if (trades.length > 0) {
    return { up: trades[0].upPrice, down: trades[0].downPrice };
  }
  return { up: '0.50', down: '0.50' };
}

const server = http.createServer((req, res) => {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/api/trades') {
    try {
      const trades = parseLog();
      const balance = getBalance();
      const running = isBotRunning();
      const market = getMarketPrices(trades);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ trades, balance, running, market }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── Periodic export of trades.json + git push ──
const TRADES_JSON = path.join(__dirname, 'trades.json');
const EXPORT_INTERVAL = 2 * 60 * 1000; // 2 minutes

function exportAndPush() {
  try {
    const trades = parseLog();
    const balance = getBalance();
    const running = isBotRunning();
    const market = getMarketPrices(trades);

    const data = {
      trades,
      balance,
      running,
      market,
      exportedAt: new Date().toISOString(),
    };

    fs.writeFileSync(TRADES_JSON, JSON.stringify(data, null, 2));

    // Stage, commit, and push trades.json
    execSync('git add trades.json', { cwd: __dirname, timeout: 10000 });
    const status = execSync('git diff --cached --name-only', { cwd: __dirname, encoding: 'utf-8' });
    if (status.trim()) {
      execSync('git commit -m "data: update trades.json"', { cwd: __dirname, timeout: 10000 });
      execSync('git push origin main', { cwd: __dirname, timeout: 30000 });
      console.log(`[${new Date().toISOString()}] trades.json exported and pushed`);
    } else {
      console.log(`[${new Date().toISOString()}] trades.json unchanged, skipping push`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Export/push failed:`, e.message);
  }
}

server.listen(PORT, () => {
  console.log(`Trading dashboard running at http://localhost:${PORT}`);
  // Initial export after 5s (let server start), then every 2 minutes
  setTimeout(exportAndPush, 5000);
  setInterval(exportAndPush, EXPORT_INTERVAL);
});
