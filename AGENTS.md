# AGENTS.md

このリポジトリで作業する AI コーディングエージェント向けの手引きです。


## プロジェクト概要

PLaMo Translate Demo は、PLaMo 3 Translate をブラウザの中だけで動かす翻訳デモです。

- **高速な推論**: LiteRT-LM と WebGPU で、利用者の GPU を使って翻訳する
- **ローカル完結**: 推論はすべてブラウザ内で行い、入力テキストと翻訳結果を外部サーバーへ送信しない

ページは GitHub Pages、モデルは Hugging Face から配信します。`main` への push で [deploy-pages.yml](.github/workflows/deploy-pages.yml) が lint、ビルド、公開を行います。


## 技術スタック

| 区分 | 採用 |
|---|---|
| 言語 | TypeScript (`strict`) |
| ランタイム、パッケージ管理 | Bun (npm / yarn / pnpm は使わない) |
| UI | React 19 (関数コンポーネントと Hooks のみ) |
| スタイル | Tailwind CSS 4 + daisyUI 5 |
| ビルド | Vite 8 |
| 推論 | LiteRT-LM (`@litert-lm/core` 0.19.0、完全一致で固定) |
| Lint | ESLint (typescript-eslint、react-hooks) |

`@litert-lm/core` の版は、モデルの検証をこの版で行っているので固定しています。上げるときは `bun run verify` で参照出力との照合をやり直します。


## コマンド

```bash
bun install
bun run dev          # 開発サーバー (Vite、5173)
bun run build        # 型チェック + 本番ビルド (dist/)
bun run preview      # ビルド成果物のプレビュー
bun run lint
bun run typecheck    # tsc --noEmit
```

- 作業を完了とする前に、`bun run typecheck`、`bun run lint`、`bun run build` が通ることを確認します。単体テストはありません。
- 依存の追加は `bun add <pkg>` / `bun add -d <pkg>` で行い、`bun.lock` を一緒に更新します。
- `predev` と `prebuild` が SDK の WASM を `public/litert-wasm/` に同期します。このフォルダは生成物で、編集もコミットもしません。

### モデルの置き場所

- 開発サーバーとプレビューは、モデルを `/models/*` から読みます。`.env.example` を `.env.local` にコピーし、`PLAMO_MODELS_DIR` に `.litertlm` を置いたフォルダを指定します。
- 本番ビルドは、`.env.production` にある Hugging Face の URL (コミット固定) から読みます。手元のモデルで本番ビルドを試すときは、`.env.production.local` で `/models` に上書きします。
- モデルファイルはリポジトリにも `public/` にも置きません。

### 照合用スクリプト (開発環境専用)

実際のモデルと WebGPU 対応の Chrome、手元の参照データ (`PLAMO_REFERENCE_DIR`) が必要です。CI では動きません。結果とログは `.verify/` (コミットしない) に出ます。

```bash
bun run verify            # 本番ビルド相当で、推論レイヤーと訳文を照合する
bun run verify dev        # 開発サーバーで起動と翻訳だけを確かめる
bun run verify models     # 4 モデルを照合し、GPU メモリと生成速度を測る
bun run verify:ui         # 実際のモデルで画面を操作して確かめる
bun run verify:tabs       # 複数タブでの Engine の共有を確かめる
bun run verify:tokenizer  # 自前のトークナイザーを元の実装の結果と照合する
bun run verify:screens    # 画面の各状態を撮影する (モデルは不要)
```

推論、Worker、トークナイザーに触れたら該当する `verify` を、画面に触れたら `verify:screens` か `verify:ui` を実行します。実行できない環境では、未確認であることを報告します。


## アーキテクチャ

依存の向きは上から下の一方向です。

| レイヤー | 場所 | 責務 |
|---|---|---|
| UI | `src/components/` | 表示と操作。推論の詳細を知らない |
| フック | `src/hooks/` | UI に状態と操作を渡す |
| ストア | `src/inference/translatorStore.ts` | 状態 (`ModelState`、`TranslationState`) の管理。React の外のシングルトン |
| クライアント | `src/inference/client.ts`、`protocol.ts` | Worker の起動、破棄、メッセージの送受信 |
| Worker | `src/inference/inference.{shared,worker}.ts`、`src/inference/worker/` | SDK の呼び出し、ダウンロード (OPFS)、GPU の監視、タブ間の共有 |
| 設定 | `src/config/` | モデル、言語、フォント、口調の定義 |

守ること:

- **`@litert-lm/core` を import してよいのは `src/inference/worker/` だけです。** 主スレッドで動かすと、画面が止まり、非表示のタブで生成が極端に遅くなります。
- **Worker はクラシック形式です。** `new Worker` / `new SharedWorker` に `type: 'module'` を付けません (SDK が `importScripts` を使うため)。
- **Worker の入口 (`inference.worker.ts`、`inference.shared.ts`) には `import` も `export` も書きません。** `import type` も不可です。本体は動的 `import()` で読みます。
- **モデルと WASM の URL は主スレッドで `import.meta.env` から組み立てて Worker に渡します。**
- **1 つの Worker で読み込むモデルは 1 つ、Engine の作成は一度だけです。** モデルやコンテキスト長を切り替えるときは Worker ごと作り直します。
- 同じモデルとコンテキスト長を選んだタブは、SharedWorker で 1 つの Engine を共有します。使えないブラウザでは専用 Worker に切り替わります。両方の経路 (`worker/shared.ts`、`worker/dedicated.ts`) を壊さないようにします。
- `src/config/toneRows.ts` は生成したファイルです。手で書き換えません。口調の機能は `TONES_ENABLED` (`src/config/tones.ts`) で止めてあります。
- SDK の呼び出し順、サンプラーの設定、GPU エラーの扱いなどは実機で確かめた結果に基づいています。変える前に SPEC.md の 4 節、6 節、12 節を読みます。


## プライバシーとローカル完結 (最優先)

このプロジェクトの根幹となる方針です。以下に反する変更は行いません。

- 原文と訳文を外部に送信しない。ストレージ (`localStorage` など) とコンソールにも残さない。
- アナリティクス、トラッキング、外部ログ送信の SDK を追加しない。
- 外部への通信はモデルファイルの取得 (`huggingface.co`、`*.hf.co`) だけに限る。WASM、フォント、スタイルはすべて自前で配信し、CDN は使わない。
- 本番ビルドの CSP (`vite.config.ts`) は主スレッドにしか効きません。Worker の中で `fetch` するのは `worker/modelStore.ts` (モデル) と同梱した語彙の読み込みだけに保ちます。
- 外部 CDN やサードパーティ API への依存を追加したい場合は、実装前に理由を示して確認を取ります。


## コーディング規約

- TypeScript: `any` は使わない (`unknown` と型ガード)。型のみの import は `import type` (`verbatimModuleSyntax`、ESLint で強制)。
- React: 1 ファイル 1 コンポーネントで、ファイル名はコンポーネント名と同じ PascalCase。副作用を持つ処理 (推論、ストレージ) はフックかストアに置く。
- スタイル: daisyUI のコンポーネントと Tailwind のユーティリティで書く。色はテーマカラー (`primary`、`base-100` など) を使い、ハードコードしない。独自の CSS とインラインスタイルは最小限にする。ライトとダークの両テーマ、375 px 幅で崩れないこと。
- コメントと利用者向けの文言は日本語で書く。エラーの文言は `src/inference/errors.ts` にまとめる。
- ライセンス表示 (「Built with PLaMo」、ライセンス全文へのリンク、モデル名に「PLaMo」を含める) を外さない。


## 作業の進め方

- 変更前に関連ファイルと SPEC.md の該当節を読み、既存の構成と命名に合わせる。
- 大きな設計変更、依存ライブラリの追加や置き換えは、実装前に提案して確認を取る。
- LiteRT-LM と WebGPU の API は変化が速いので、記憶に頼らず `node_modules/@litert-lm/core` の型定義や公式ドキュメントを確認してから使う。
- 動作確認は WebGPU 対応ブラウザ (最新の Chrome / Edge) で行う。
