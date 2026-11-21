#!/usr/bin/env node
/* Manage the workshop passwords. Run from this folder, in your own terminal
   (it asks for passwords without echoing them).

     ./access.mjs list
     ./access.mjs add <name> [--days N] [--until YYYY-MM-DD]   create, or change its password
     ./access.mjs edit <name> [--days N] [--until YYYY-MM-DD|none]   change durations only
     ./access.mjs remove <name>
     ./access.mjs link <name> [--qr]                           magic link; --qr also saves qr-<name>.png
                                                               and prints the QR in the terminal (needs qrencode)
     ./access.mjs push                                         re-upload the list as is (e.g. after a failed upload)
     ./access.mjs help

   --local  work on a separate test list, access.local.json (gitignored), and
            .dev.vars (for `wrangler dev`) only; never touches access.json or
            Cloudflare. Works with every command, e.g. `list --local`.
   --days   how long a device stays logged in after typing the password (default 120)
   --until  last day the password works; sessions never outlive it (default: no end)
   --allow-short  accept a password under 12 characters (throwaway tests only)

   The real list lives in access.json (hashes only, never plaintext; encrypted in
   git by git-crypt). Every change without --local rewrites access.json and
   .dev.vars and uploads the whole list to Cloudflare as the ACCESS secret with
   `wrangler secret put`, which takes effect immediately. See DESIGN.md. */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(DIR, '.dev.vars');
const SITE = 'https://htarrega.me/ai-and-narrative/';

const die = msg => { console.error('✘ ' + msg); process.exit(1); };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') out.local = true;
    else if (a === '--qr') out.qr = true;
    else if (a === '--allow-short') out.allowShort = true;
    else if (a === '--help' || a === '-h') out._.unshift('help');
    else if (a === '--days' || a === '--until') out[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) die(`unknown flag ${a}`);
    else out._.push(a);
  }
  return out;
}

function checkName(n) {
  if (!n || !/^[a-z0-9-]+$/.test(n)) die('name: lowercase letters, digits and hyphens only (e.g. bibliocafe)');
  return n;
}
function checkDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) die('--days must be a number of days between 1 and 3650');
  return n;
}
function checkUntil(u) {
  if (u === 'none') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u) || isNaN(Date.parse(u))) die('--until must be YYYY-MM-DD (or "none")');
  return u;
}

/* Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  if (process.env.AIN_PASSWORD) return Promise.resolve(process.env.AIN_PASSWORD); // tests only
  if (!process.stdin.isTTY) die('run this in a real terminal (it needs to ask for the password)');
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n'); return resolve(buf);
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const magicKey = e => `${e.name}.${createHmac('sha256', e.hash).update(`magic|${e.name}`).digest('hex')}`;

function describe(e) {
  return `${e.name.padEnd(16)} session ${String(e.sessionDays).padStart(4)} days   ` +
    `valid until ${e.until || '(no end)'}   created ${e.created}`;
}

function save(list) {
  writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n');
  const json = JSON.stringify(list.map(({ name, salt, hash, sessionDays, until }) => ({ name, salt, hash, sessionDays, until })));
  writeFileSync(DEV_VARS, `ACCESS='${json}'\n`, { mode: 0o600 });
  if (args.local) { console.log(`✔ saved locally (${basename(FILE)}, .dev.vars). Restart \`wrangler dev\` to pick it up.`); return; }
  const r = spawnSync('wrangler', ['secret', 'put', 'ACCESS'], { cwd: DIR, input: json, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) die('wrangler secret put failed; access.json is saved, re-run the command once wrangler works (`wrangler login`).');
  console.log('✔ uploaded to Cloudflare. Active now.');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, rawName] = args._;
// --local keeps test entries out of the real list, so a later upload can't ship them.
const FILE = join(DIR, args.local ? 'access.local.json' : 'access.json');
const list = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
const today = () => new Date().toISOString().slice(0, 10);
const find = name => list.find(e => e.name === name);
const existing = name => find(name) || die(`no password called "${name}"`);

switch (cmd) {
  case 'list': {
    if (args.local) console.log('Local test list (access.local.json, used by wrangler dev):');
    if (!list.length) console.log('(no passwords yet; add one with ./access.mjs add <name>)');
    for (const e of list) console.log((e.until && e.until < today() ? 'EXPIRED  ' : 'active   ') + describe(e));
    break;
  }
  case 'add': {
    const name = checkName(rawName);
    const old = find(name);
    const raw = await askHidden(`New password for "${name}": `);
    const pw = raw.trim(); // never store spaces at the ends (the Worker also trims on login)
    if (pw !== raw) console.log('Note: removed spaces at the start/end of the password.');
    if (/\s/.test(pw)) die('no spaces inside the password (join words with hyphens, e.g. farola-ciruela-mapa-trueno)');
    if (pw.length < 12 && !args.allowShort) die('use at least 12 characters (4 random words joined with hyphens is ideal), or pass --allow-short for a throwaway test password');
    if (!process.env.AIN_PASSWORD && pw !== (await askHidden('Repeat it: ')).trim()) die("they don't match");
    const salt = randomBytes(16).toString('hex');
    const entry = {
      name, salt,
      hash: createHash('sha256').update(salt + pw).digest('hex'),
      sessionDays: args.days ? checkDays(args.days) : old?.sessionDays ?? 120,
      until: args.until ? checkUntil(args.until) : old?.until ?? null,
      created: today(),
    };
    save(list.filter(e => e.name !== name).concat(entry));
    console.log((old ? 'Changed: ' : 'Added:   ') + describe(entry));
    if (old) console.log('  Everyone logged in with the old one is logged out; its old magic link stops working.');
    break;
  }
  case 'edit': {
    const e = existing(checkName(rawName));
    if (!args.days && !args.until) die('nothing to change: pass --days and/or --until');
    if (args.days) e.sessionDays = checkDays(args.days);
    if (args.until) e.until = checkUntil(args.until);
    save(list);
    console.log('Edited:  ' + describe(e));
    console.log('  Applies to new logins. Devices already logged in keep their current end date (but never past --until).');
    break;
  }
  case 'remove': {
    const name = existing(checkName(rawName)).name;
    save(list.filter(e => e.name !== name));
    console.log(`Removed "${name}". Everyone who entered with it is logged out now.`);
    break;
  }
  case 'push': {
    if (!list.length) die('nothing to push: add a password first');
    save(list);
    break;
  }
  case 'link': {
    const e = existing(checkName(rawName));
    const url = `${SITE}?k=${magicKey(e)}`;
    console.log(url);
    console.log('Anyone with this link gets in without typing the password. It dies when the password changes or is removed.');
    if (args.qr) {
      const png = join(DIR, `qr-${e.name}.png`);
      const a = spawnSync('qrencode', ['-o', png, '-s', '16', '-m', '2', '-l', 'M', url], { stdio: 'inherit' });
      if (a.error || a.status !== 0) die('qrencode not found: install it with `sudo apt install qrencode`');
      spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '2', url], { stdio: 'inherit' });
      console.log(`QR saved to ${png} (gitignored). Treat it like the password: anyone who scans it gets in.`);
    }
    break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '').replace(/^ {3}/gm, ''));
}
