//@ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const dst = path.join(__dirname, '..', 'media', 'sql-wasm.wasm');

fs.copyFileSync(src, dst);
console.log('Copied sql-wasm.wasm to media/');
