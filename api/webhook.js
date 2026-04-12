// api/webhook.js
// Receives instant payment notifications from Alchemy (ETH/SOL/USDC) and Blockonomics (BTC)
// Vercel runs this as a serverless function at https://yoursite.com/api/webhook

// ── Your wallet addresses ──
const ADDRESSES = {
  btc:  'bc1q7n3vqfsy0sm8res9vltk8zcdd996ux5gdp2jfx',
  eth:  '0xe8153fd51a3f7d52a2a8cc84a9523e195e17f5a7',
  sol:  '5mcfJ1ZSvhypqt4EpMFPHkte5brgMQYLbnN6yXNRgWGb',
  usdc: '5mcfJ1ZSvhypqt4EpMFPHkte5brgMQYLbnN6yXNRgWGb',
};

// ── In-memory store of detected payments ──
// Each entry: { txid, amount, ticker, timestamp, address }
// NOTE: This resets on cold starts. For production, replace with a database
// like Vercel KV (free tier available) — see README comment at bottom.
if (!global.detectedPayments) global.detectedPayments = [];

export default async function handler(req, res) {
  // Allow OPTIONS for CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-alchemy-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: payment page polls this to check if payment arrived ──
  if (req.method === 'GET') {
    const { since } = req.query;
    const sinceTs = parseInt(since || '0', 10);
    const newPayments = global.detectedPayments.filter(p => p.timestamp >= sinceTs);
    return res.status(200).json({ payments: newPayments });
  }

  // ── POST: webhook from Alchemy or Blockonomics ──
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // ── BLOCKONOMICS (BTC) ──
      // Blockonomics sends: { addr, value, txid, status }
      if (body.addr && body.txid && body.value !== undefined) {
        const addr = body.addr.toLowerCase();
        if (addr === ADDRESSES.btc.toLowerCase()) {
          const satoshis = parseInt(body.value, 10);
          const btc = (satoshis / 1e8).toFixed(8);
          storePayment({
            txid:    body.txid,
            amount:  btc,
            ticker:  'BTC',
            address: body.addr,
            explorer:`https://mempool.space/tx/${body.txid}`,
          });
          console.log(`BTC payment detected: ${btc} BTC — ${body.txid}`);
          return res.status(200).json({ status: 'ok' });
        }
      }

      // ── ALCHEMY (ETH) ──
      // Alchemy Address Activity webhook sends activity array
      if (body.type === 'ADDRESS_ACTIVITY' && Array.isArray(body.event?.activity)) {
        for (const act of body.event.activity) {
          const toAddr = (act.toAddress || '').toLowerCase();
          if (toAddr === ADDRESSES.eth.toLowerCase()) {
            const value = act.value || 0;
            const ticker = act.asset || 'ETH';
            const txid = act.hash;
            storePayment({
              txid,
              amount:  value.toString(),
              ticker,
              address: act.toAddress,
              explorer:`https://etherscan.io/tx/${txid}`,
            });
            console.log(`ETH/ERC20 payment detected: ${value} ${ticker} — ${txid}`);
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      // ── ALCHEMY (SOL / USDC) ──
      // Alchemy Solana webhook also uses ADDRESS_ACTIVITY
      if (body.type === 'ADDRESS_ACTIVITY' && body.event?.network?.includes('SOL')) {
        for (const act of body.event?.activity || []) {
          const toAddr = act.toAddress || '';
          if (toAddr === ADDRESSES.sol) {
            const ticker = act.asset === 'USDC' ? 'USDC' : 'SOL';
            const txid   = act.hash;
            storePayment({
              txid,
              amount:  (act.value || 0).toString(),
              ticker,
              address: toAddr,
              explorer:`https://solscan.io/tx/${txid}`,
            });
            console.log(`SOL payment detected: ${act.value} ${ticker} — ${txid}`);
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      // Unknown payload — log and return ok so webhook doesn't retry
      console.log('Unknown webhook payload:', JSON.stringify(body).slice(0, 200));
      return res.status(200).json({ status: 'ignored' });

    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function storePayment(payment) {
  payment.timestamp = Math.floor(Date.now() / 1000);
  // Avoid storing duplicates
  const exists = global.detectedPayments.find(p => p.txid === payment.txid);
  if (!exists) {
    global.detectedPayments.push(payment);
    // Keep last 100 payments in memory
    if (global.detectedPayments.length > 100) {
      global.detectedPayments = global.detectedPayments.slice(-100);
    }
  }
}

/*
──────────────────────────────────────────────────────
  OPTIONAL UPGRADE: Persistent storage with Vercel KV
──────────────────────────────────────────────────────
  The in-memory store above resets on serverless cold starts.
  For 100% persistence, add Vercel KV (free tier):

  1. In Vercel dashboard → Storage → Create KV Database
  2. Run: npm install @vercel/kv
  3. Replace storePayment() with:

  import { kv } from '@vercel/kv';

  async function storePayment(payment) {
    payment.timestamp = Math.floor(Date.now() / 1000);
    await kv.lpush('payments', JSON.stringify(payment));
    await kv.ltrim('payments', 0, 99);
  }

  And in GET handler:
  const all = await kv.lrange('payments', 0, -1);
  const payments = all.map(p => JSON.parse(p)).filter(p => p.timestamp >= sinceTs);
──────────────────────────────────────────────────────
*/
