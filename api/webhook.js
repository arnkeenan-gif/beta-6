// api/webhook.js
// Receives instant payment notifications from Alchemy (ETH/SOL/USDC) and Blockonomics (BTC)

const ADDRESSES = {
  btc:  'bc1q7n3vqfsy0sm8res9vltk8zcdd996ux5gdp2jfx',
  eth:  '0xe8153fd51a3f7d52a2a8cc84a9523e195e17f5a7',
  sol:  '5mcfJ1ZSvhypqt4EpMFPHkte5brgMQYLbnN6yXNRgWGb',
  usdc: '5mcfJ1ZSvhypqt4EpMFPHkte5brgMQYLbnN6yXNRgWGb',
};

if (!global.detectedPayments) global.detectedPayments = [];

function storePayment(payment) {
  payment.timestamp = Math.floor(Date.now() / 1000);
  const exists = global.detectedPayments.find(p => p.txid === payment.txid);
  if (!exists) {
    global.detectedPayments.push(payment);
    if (global.detectedPayments.length > 100) {
      global.detectedPayments = global.detectedPayments.slice(-100);
    }
    console.log('Payment stored:', payment.txid, payment.amount, payment.ticker);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-alchemy-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: payment page polls this every 5 seconds ──
  if (req.method === 'GET') {
    const since = parseInt(req.query.since || '0', 10);
    const newPayments = global.detectedPayments.filter(p => p.timestamp >= since);
    return res.status(200).json({ payments: newPayments, total: global.detectedPayments.length });
  }

  // ── POST: called by Alchemy or Blockonomics the instant payment arrives ──
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body) return res.status(400).json({ error: 'No body' });

      // ── BLOCKONOMICS (BTC) ──
      // Sends: { addr, value, txid, status }
      if (body.addr && body.txid && body.value !== undefined) {
        const addr = (body.addr || '').toLowerCase();
        if (addr === ADDRESSES.btc.toLowerCase()) {
          const btc = (parseInt(body.value, 10) / 1e8).toFixed(8);
          storePayment({
            txid:     body.txid,
            amount:   btc,
            ticker:   'BTC',
            address:  body.addr,
            explorer: `https://mempool.space/tx/${body.txid}`,
          });
        }
        return res.status(200).json({ status: 'ok' });
      }

      // ── ALCHEMY (ETH + ERC-20 tokens) ──
      if (body.type === 'ADDRESS_ACTIVITY' && Array.isArray(body.event && body.event.activity)) {
        for (const act of body.event.activity) {
          const toAddr = (act.toAddress || '').toLowerCase();
          if (toAddr === ADDRESSES.eth.toLowerCase()) {
            storePayment({
              txid:     act.hash,
              amount:   String(act.value || 0),
              ticker:   act.asset || 'ETH',
              address:  act.toAddress,
              explorer: `https://etherscan.io/tx/${act.hash}`,
            });
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      // ── ALCHEMY (SOL / USDC) ──
      if (body.type === 'ADDRESS_ACTIVITY') {
        const activity = (body.event && body.event.activity) || [];
        for (const act of activity) {
          const toAddr = act.toAddress || '';
          if (toAddr === ADDRESSES.sol) {
            const ticker = act.asset === 'USDC' ? 'USDC' : 'SOL';
            storePayment({
              txid:     act.hash,
              amount:   String(act.value || 0),
              ticker,
              address:  toAddr,
              explorer: `https://solscan.io/tx/${act.hash}`,
            });
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      // Unknown payload — return 200 so webhook provider doesn't retry endlessly
      console.log('Unhandled webhook payload type:', body.type || 'unknown');
      return res.status(200).json({ status: 'ignored' });

    } catch (err) {
      console.error('Webhook handler error:', err.message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
