// SDK の wasm/ を public/litert-wasm/ に同期する。cdn.jsdelivr.net から読ませないために自前で配信する。
import {cpSync, rmSync} from 'node:fs';

rmSync('public/litert-wasm', {recursive: true, force: true});
cpSync('node_modules/@litert-lm/core/wasm', 'public/litert-wasm', {recursive: true});
