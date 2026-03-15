const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 5174;
const LOG_FILE = '/tmp/polymarket-auto.log';
const SCALP_LOG_FILE = '/tmp/polymarket-scalp.log';
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

// Collect all Redeem outcomes with explicit winner= from the scalp log
function collectScalpRedeems() {
  if (!fs.existsSync(SCALP_LOG_FILE)) return {};
  const log = fs.readFileSync(SCALP_LOG_FILE, 'utf-8');
  const outcomes = {};
  const re = /\[Redeem\] btc-updown-5m-(\d+): UP=(\d+), DOWN=(\d+), winner=(\w+)/g;
  let m;
  while ((m = re.exec(log)) !== null) {
    outcomes[m[1]] = { winner: m[4], up: parseInt(m[2]), down: parseInt(m[3]) };
  }
  return outcomes;
}

function parseLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const log = fs.readFileSync(LOG_FILE, 'utf-8');
  const blocks = log.split(/(?=\[自动策略\] 新窗口)/);

  const pad = n => String(n).padStart(2, '0');

  // Get explicit Redeem outcomes from scalp log to resolve pending trades
  const scalpRedeems = collectScalpRedeems();

  // First pass: parse all trade blocks
  const parsedBlocks = [];
  for (const block of blocks) {
    const windowMatch = block.match(/\[自动策略\] 新窗口: (\d+) \((\d{4}-\d{2}-\d{2}T[\d:]+\.\d+Z)\)/);
    if (!windowMatch) continue;

    const slugMatch = block.match(/Slug: btc-updown-5m-(\d+)/);
    const balanceMatch = block.match(/\[余额\] USDC: \$([\d.]+)/);
    const orderMatch = block.match(/\[下单\] 方向=(UP|DOWN), 金额=\$([\d.]+)/);
    const successMatch = block.match(/\[成功\] 状态: (\w+)/);
    const orderIdMatch = block.match(/\[成功\] 订单ID: (0x[\da-f]+)/i);
    const upPriceMatch = block.match(/UP\s+价格: \$([\d.]+)/);
    const downPriceMatch = block.match(/DOWN\s*价格: \$([\d.]+)/);
    const failMatch = block.match(/\[失败\]/) || block.match(/\[错误\]/);

    let strategy = 'unknown';
    if (block.includes('[过度自信反转]')) strategy = 'overconfidence-reversal';
    else if (block.includes('[趋势跟随]')) strategy = 'trend-follow';
    else if (block.includes('[低波动反转]')) strategy = 'low-vol-reversal';
    else if (block.includes('[跳过]') || block.includes('无明确信号')) strategy = 'skip';

    // Collect redeem lines in this block (for previous windows)
    const redeems = [];
    const redeemRe = /\[Redeem\] btc-updown-5m-(\d+): UP=(\d+), DOWN=(\d+)(?:, winner=(\w+))?/g;
    let m;
    while ((m = redeemRe.exec(block)) !== null) {
      redeems.push({ slugId: m[1], up: parseInt(m[2]), down: parseInt(m[3]), winner: m[4] || null });
    }

    parsedBlocks.push({
      windowId: windowMatch[1],
      isoTime: windowMatch[2],
      slugId: slugMatch ? slugMatch[1] : windowMatch[1],
      balance: balanceMatch ? parseFloat(balanceMatch[1]) : null,
      dir: orderMatch ? orderMatch[1] : null,
      amount: orderMatch ? parseFloat(orderMatch[2]) : 0,
      strategy,
      success: !!successMatch && !failMatch,
      orderId: orderIdMatch ? orderIdMatch[1] : null,
      upPrice: upPriceMatch ? upPriceMatch[1] : '0.50',
      downPrice: downPriceMatch ? downPriceMatch[1] : '0.50',
      redeems,
    });
  }

  // Second pass: determine outcomes
  // Use scalp log redeems (explicit winner) first, then fallback to balance-change inference
  const outcomes = {}; // slugId → { winner: 'UP'|'DOWN' }
  for (let i = 0; i < parsedBlocks.length; i++) {
    const curr = parsedBlocks[i];
    const next = parsedBlocks[i + 1];

    for (const r of curr.redeems) {
      if (r.winner) {
        outcomes[r.slugId] = { winner: r.winner };
        continue;
      }
      // Check scalp log for explicit winner
      if (scalpRedeems[r.slugId]) {
        outcomes[r.slugId] = { winner: scalpRedeems[r.slugId].winner };
        continue;
      }
      // Infer winner from balance change
      if (next && curr.balance != null && next.balance != null) {
        const gain = next.balance - (curr.balance - curr.amount);
        const tokenSide = r.up > 0 ? 'UP' : 'DOWN';
        if (gain > 0.01) {
          outcomes[r.slugId] = { winner: tokenSide };
        } else {
          outcomes[r.slugId] = { winner: tokenSide === 'UP' ? 'DOWN' : 'UP' };
        }
      }
    }
  }

  // Also check scalp redeems for any trade slugIds not yet resolved
  for (const pb of parsedBlocks) {
    if (!outcomes[pb.slugId] && scalpRedeems[pb.slugId]) {
      outcomes[pb.slugId] = { winner: scalpRedeems[pb.slugId].winner };
    }
  }

  // Third pass: build trade list with price-based PnL
  const trades = [];
  for (const pb of parsedBlocks) {
    if (pb.strategy === 'skip' || !pb.dir || !pb.success) continue;

    const ts = new Date(pb.isoTime);
    const tsStr = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

    let result = 'pending';
    let pnl = 0;

    const outcome = outcomes[pb.slugId];
    if (outcome) {
      if (pb.dir === outcome.winner) {
        result = 'won';
        // Use price-based PnL (Redeem shares are unreliable due to multi-source tokens)
        const price = pb.dir === 'UP' ? parseFloat(pb.upPrice) : parseFloat(pb.downPrice);
        pnl = price > 0 ? (1 / price - 1) * pb.amount : 0;
      } else {
        result = 'lost';
        pnl = -pb.amount;
      }
    }

    trades.push({
      ts: tsStr,
      dir: pb.dir,
      amount: pb.amount,
      result,
      pnl: Math.round(pnl * 100) / 100,
      strategy: pb.strategy,
      upPrice: pb.upPrice,
      downPrice: pb.downPrice,
      orderId: pb.orderId,
    });
  }

  return trades.reverse(); // newest first
}

function parseScalpLog() {
  if (!fs.existsSync(SCALP_LOG_FILE)) return [];
  const log = fs.readFileSync(SCALP_LOG_FILE, 'utf-8');
  const lines = log.split('\n');

  const pad = n => String(n).padStart(2, '0');

  // Collect Redeem outcomes for resolving "卖出失败" trades
  const redeemOutcomes = collectScalpRedeems();

  const trades = [];
  let windowId = null, windowTime = null;
  let upPrice = '0.50', downPrice = '0.50';
  let currentTrade = null;
  let tradeIndex = 0;

  for (const line of lines) {
    // Window header: [刷单] ═══ 窗口 1773590700 (2026-03-15T16:05:00.000Z) ═══
    const windowMatch = line.match(/\[刷单\] ═══ 窗口 (\d+) \((\d{4}-\d{2}-\d{2}T[\d:]+\.\d+Z)\) ═══/);
    if (windowMatch) {
      windowId = windowMatch[1];
      windowTime = windowMatch[2];
      tradeIndex = 0;
      continue;
    }

    // BTC price line: UP=$0.51 DOWN=$0.49
    const priceMatch = line.match(/UP=\$([\d.]+)\s+DOWN=\$([\d.]+)/);
    if (priceMatch && line.includes('[刷单]')) {
      upPrice = priceMatch[1];
      downPrice = priceMatch[2];
      continue;
    }

    // Open position: [刷单] 开仓 UP $1.00 → 1.613 tokens @$0.505
    const openMatch = line.match(/\[刷单\] 开仓 (UP|DOWN) \$([\d.]+) → ([\d.]+) tokens @\$([\d.]+)/);
    if (openMatch && windowId) {
      // If previous trade was never closed, push it as pending
      if (currentTrade) {
        trades.push(currentTrade);
      }
      const ts = new Date(windowTime);
      ts.setSeconds(ts.getSeconds() + tradeIndex * 60);
      const tsStr = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

      currentTrade = {
        ts: tsStr,
        windowId,
        dir: openMatch[1],
        amount: parseFloat(openMatch[2]),
        tokens: parseFloat(openMatch[3]),
        entryPrice: parseFloat(openMatch[4]),
        result: 'pending',
        pnl: 0,
        strategy: 'scalp',
        upPrice,
        downPrice,
        orderId: null,
      };
      tradeIndex++;
      continue;
    }

    // Close success: [平仓] 成功 收回=$1.367 PnL=$0.367
    const closeMatch = line.match(/\[平仓\] 成功 收回=\$([\d.]+) PnL=\$([-\d.]+)/);
    if (closeMatch && currentTrade) {
      const pnl = parseFloat(closeMatch[2]);
      currentTrade.pnl = Math.round(pnl * 100) / 100;
      currentTrade.result = pnl > 0 ? 'won' : 'lost';
      delete currentTrade.windowId;
      delete currentTrade.tokens;
      delete currentTrade.entryPrice;
      trades.push(currentTrade);
      currentTrade = null;
      continue;
    }

    // Close failure: [平仓] 卖出失败, 持有到结算 → resolve from Redeem
    if (line.includes('[平仓] 卖出失败') && currentTrade) {
      const redeem = redeemOutcomes[currentTrade.windowId];
      if (redeem) {
        const isWin = currentTrade.dir === redeem.winner;
        currentTrade.result = isWin ? 'won' : 'lost';
        if (isWin) {
          // PnL = price-based theoretical profit (reliable for $1 FOK orders)
          const price = currentTrade.entryPrice;
          currentTrade.pnl = price > 0 ? Math.round((1 / price - 1) * currentTrade.amount * 100) / 100 : 0;
        } else {
          currentTrade.pnl = -currentTrade.amount;
        }
      }
      delete currentTrade.windowId;
      delete currentTrade.tokens;
      delete currentTrade.entryPrice;
      trades.push(currentTrade);
      currentTrade = null;
      continue;
    }
  }

  // Unclosed trade → pending
  if (currentTrade) {
    delete currentTrade.windowId;
    delete currentTrade.tokens;
    delete currentTrade.entryPrice;
    trades.push(currentTrade);
  }

  return trades.reverse(); // newest first
}

function getAllTrades() {
  const autoTrades = parseLog();
  const scalpTrades = parseScalpLog();
  const all = [...autoTrades, ...scalpTrades];
  all.sort((a, b) => b.ts.localeCompare(a.ts));
  return all;
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
      const trades = getAllTrades();
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
    const trades = getAllTrades();
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
