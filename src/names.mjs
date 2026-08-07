// Human-style random username generator.
//
// Produces realistic mailbox local-parts like emma.chen, liam.walker92,
// sarahmiller, a.kim_1999 — no `th-` prefix, no consecutive hex, no shared
// template that would let a risk engine fingerprint the batch.
//
// Templates (rolled once per call, weighted):
//   first.last        28%   emma.chen
//   first.lastNN      24%   liam.walker92
//   firstlast         14%   sarahmiller
//   firstlastNN       12%   jamesbrown77
//   first.lastYYYY    10%   olivia.lee1999
//   f.lastNN          6%    e.kim203
//   first_NN          4%    hannah_88
//   first             2%    nina          (high collision risk; low weight + dedup)
//
// All names are common given/surnames; no celebrity-only names.

const FIRST = [
  'emma', 'olivia', 'ava', 'sophia', 'mia', 'isabella', 'charlotte', 'amelia',
  'harper', 'evelyn', 'abigail', 'liam', 'noah', 'oliver', 'elijah', 'james',
  'william', 'benjamin', 'lucas', 'henry', 'alexander', 'mason', 'ethan',
  'daniel', 'jackson', 'logan', 'samuel', 'michael', 'jacob', 'sophie',
  'grace', 'lily', 'hannah', 'chloe', 'zoe', 'emily', 'sarah', 'jessica',
  'lauren', 'rachel', 'rebecca', 'matthew', 'joshua', 'ryan', 'tyler',
  'brandon', 'nicholas', 'austin', 'kyle', 'adam', 'kevin', 'eric', 'brian',
  'jason', 'mark', 'steven', 'andrew', 'david', 'john', 'robert', 'nina',
  'maya', 'kai', 'luna', 'nora',
];

const LAST = [
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller',
  'davis', 'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez',
  'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin',
  'lee', 'perez', 'thompson', 'white', 'harris', 'sanchez', 'clark',
  'ramirez', 'lewis', 'robinson', 'walker', 'young', 'allen', 'king',
  'wright', 'scott', 'torres', 'nguyen', 'hill', 'flores', 'green', 'adams',
  'nelson', 'baker', 'hall', 'rivera', 'campbell', 'mitchell', 'carter',
  'roberts', 'gomez', 'phillips', 'evans', 'turner', 'diaz', 'parker',
  'cruz', 'edwards', 'collins', 'reyes', 'stewart', 'morris', 'morales',
  'murphy', 'kim', 'patel',
];

const MAX_LENGTH = 40;

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 2-3 digit random number. */
function digits(rng, min = 2, max = 3) {
  const len = min + Math.floor(rng() * (max - min + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(rng() * 10);
  return s;
}

/** Birth-year style suffix: 1975-2005. */
function year(rng) {
  return String(1975 + Math.floor(rng() * 31));
}

/**
 * Generate one human-style username (local part only, no domain).
 *
 * @param {Set<string>} used  usernames already allocated in this batch (dedup)
 * @param {() => number} rng  random source (default Math.random)
 * @returns {string} e.g. "emma.chen92"
 */
export function generateUsername(used = new Set(), rng = Math.random) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const first = pick(FIRST, rng);
    const last = pick(LAST, rng);
    const t = rng();
    let local;

    if (t < 0.28) {
      local = `${first}.${last}`;
    } else if (t < 0.52) {
      local = `${first}.${last}${digits(rng)}`;
    } else if (t < 0.66) {
      local = `${first}${last}`;
    } else if (t < 0.78) {
      local = `${first}${last}${digits(rng)}`;
    } else if (t < 0.88) {
      local = `${first}.${last}${year(rng)}`;
    } else if (t < 0.94) {
      local = `${first[0]}.${last}${digits(rng)}`;
    } else if (t < 0.98) {
      local = `${first}_${digits(rng, 2, 2)}`;
    } else {
      local = `${first}${digits(rng, 1, 2)}`;
    }

    if (local.length > MAX_LENGTH) continue;
    if (used.has(local)) continue;
    used.add(local);
    return local;
  }
  // Extremely unlikely (tiny wordlists + dedup). Fall back to name+random hex
  // only as a last resort so the caller never blocks a batch.
  const local = `${pick(FIRST, rng)}.${pick(LAST, rng)}${digits(rng, 3, 3)}`;
  if (!used.has(local)) used.add(local);
  return local;
}
