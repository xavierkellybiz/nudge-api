// The streaming dash scrubber. Run: node test-dash-scrub.js
//
// Worth its own test because the failure mode is invisible in normal use: the scrub still *mostly*
// works, it just degrades to the weaker rule and leaves "protein ,  rice" in one reply out of
// several, depending entirely on where the model happened to break its tokens.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
eval(src.slice(src.indexOf('function scrubDashes'), src.indexOf("app.post('/coach'")));

let failed = 0;
const check = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
};

/** Feed `chunks` through the scrubber and reassemble what a client would receive. */
const run = (chunks) => {
  const s = makeDashScrubber();
  let out = '';
  for (const c of chunks) out += s.push(c);
  return out + s.end();
};

const WHOLE = 'Lunch was 18g — push it to 35. Four weeks flat - that is adaptation.';
const want = scrubDashes(WHOLE);

check('one chunk matches the non-streaming scrub', run([WHOLE]) === want, run([WHOLE]));
check('character by character matches too', run([...WHOLE]) === want, run([...WHOLE]));

// Every possible split point: whichever way the model breaks its tokens, the result must be the
// same string the JSON path would have produced.
let worst = null;
for (let i = 1; i < WHOLE.length; i++) {
  const got = run([WHOLE.slice(0, i), WHOLE.slice(i)]);
  if (got !== want && !worst) worst = { at: i, got };
}
check('every two-way split matches', worst === null, worst);

// Three-way splits around the dashes, which is where it actually broke before.
let worst3 = null;
for (let i = 1; i < WHOLE.length - 1 && !worst3; i++) {
  for (let j = i + 1; j < WHOLE.length; j++) {
    const got = run([WHOLE.slice(0, i), WHOLE.slice(i, j), WHOLE.slice(j)]);
    if (got !== want) { worst3 = { i, j, got }; break; }
  }
}
check('every three-way split matches', worst3 === null, worst3);

// The specific regression: the space before the dash leaving in an earlier chunk.
const split = run(['Protein', ' —', ' rice']);
check('no double space where a dash was', !/ {2}/.test(split), split);
check('no space before the comma', !/ ,/.test(split), split);
check('nothing dash-like survives', !/[—–]|\S\s-\s\S/.test(run([...WHOLE])), run([...WHOLE]));

// Nothing is lost or duplicated.
check('no text dropped', run([...WHOLE]).replace(/[, ]/g, '') === want.replace(/[, ]/g, ''));

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
