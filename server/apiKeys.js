// Twelve Data API key rotation
// Free plan: 8 credits/min per key
// 6 keys = 48 credits/min total — enough for 8 pairs every minute

const KEYS = [
  'e7648cf5327e43d482cc42bfe6260eec',
  '3747cace4d0146fea8864fd701c6d45e',
  'a940106c2f3241c2b60b430969b5ad12',
  '8134e04673a24d488a6b2a6397f63be4',
  '38377f4fca0b44449894be078f3d6fa4',
  '7b5626d99b9e41c4b2cdafc109e611fb'
];

let index = 0;
const usage = {}; // key -> { count, resetAt }

KEYS.forEach(k => { usage[k] = { count: 0, resetAt: Date.now() + 60000 }; });

function getKey() {
  const now = Date.now();
  // Reset counters if minute passed
  KEYS.forEach(k => {
    if (now >= usage[k].resetAt) {
      usage[k].count = 0;
      usage[k].resetAt = now + 60000;
    }
  });

  // Find key with lowest usage under limit
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[(index + i) % KEYS.length];
    if (usage[k].count < 7) { // stay under 8/min
      usage[k].count++;
      index = (index + i + 1) % KEYS.length;
      return k;
    }
  }

  // All keys at limit — use next one anyway (rare)
  const k = KEYS[index % KEYS.length];
  index = (index + 1) % KEYS.length;
  return k;
}

module.exports = { getKey };
