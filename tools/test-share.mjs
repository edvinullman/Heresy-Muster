import fs from 'node:fs';
import { encodeShare, decodeShare } from '../js/store.js';
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const code = await encodeShare(raw);
const back = await decodeShare(code);
console.log('share chars', code.length, 'roundtrip ok', JSON.stringify(back) === JSON.stringify(raw));
