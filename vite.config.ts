import {createReadStream, statSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, loadEnv, type Connect, type Plugin} from 'vite';

/**
 * 開発時とプレビュー時に、/models/* を PLAMO_MODELS_DIR のファイルとして返す。
 * public/ に置くとビルド時に dist/ へコピーされるので、ミドルウェアで配信する。
 * SDK も fetch も 1 回の GET で取得するので、Range には対応しない。
 */
function serveModels(modelsDir: string | undefined): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const {pathname} = new URL(req.url ?? '/', 'http://localhost');
    if (!pathname.startsWith('/models/')) {
      next();
      return;
    }
    const notFound = (message: string) => {
      res.statusCode = 404;
      res.end(message);
    };
    if (!modelsDir) {
      notFound('PLAMO_MODELS_DIR is not set. See .env.example.');
      return;
    }
    const root = resolve(modelsDir);
    const path = resolve(root, decodeURIComponent(pathname.slice('/models/'.length)));
    if (!path.startsWith(root + sep)) {
      notFound('not found');
      return;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      notFound('not found');
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).pipe(res);
  };
  return {
    name: 'serve-models',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * 本番ビルドの通信先を制限する。GitHub Pages はレスポンスヘッダーを設定できないので <meta> で指定する。
 * ドキュメントの <meta> は主スレッドにだけ効き、Worker には効かない。
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://huggingface.co https://*.hf.co",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {tag: 'meta', attrs: {'http-equiv': 'Content-Security-Policy', content: policy}, injectTo: 'head-prepend'},
    ],
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss(), serveModels(env.PLAMO_MODELS_DIR), contentSecurityPolicy()],
    // SDK が importScripts を使うので、Worker はクラシック形式で 1 ファイルにまとめる。
    worker: {format: 'iife'},
    // SDK は Worker からしか参照されないので、指定しないとキャッシュのない開発サーバーが
    // 起動後に SDK を見つけて再最適化し、ページを再読み込みしてしまう。
    optimizeDeps: {include: ['@litert-lm/core']},
  };
});
