# PLaMo Translate Demo

[PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b) をブラウザの中だけで動かす翻訳デモです。

- **ローカル完結**: 推論はすべてブラウザ内で行います。入力した文章と訳文は外部に送信しません。通信するのは、モデルのダウンロード (Hugging Face) だけです。
- **WebGPU で高速に推論**: [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) と WebGPU で、手元の GPU を使って翻訳します。
- 53 言語、文体 (敬体 / 常体 / やさしい日本語)、参考文脈、用語集に対応しています。

## 動作環境

WebGPU に対応したブラウザ (最新の Chrome / Edge) が必要です。モデルは初回にダウンロードし、ブラウザ (OPFS) に保存します。

| モデル | ファイルサイズ | GPU メモリの目安 (コンテキスト長 8192) |
|---|---|---|
| PLaMo 3 Translate 0.8B int8 | 0.91 GB | 2.1 GiB |
| PLaMo 3 Translate 0.8B int4 (QAT 版、既定) | 0.58 GB | 1.5 GiB |
| PLaMo 3 Translate 2B int8 | 2.92 GB | 6.3 GiB |
| PLaMo 3 Translate 2B int4 | 1.75 GB | 4.3 GiB |

モデルは次のリポジトリで配布しています。

- [OS-Software/plamo-3-translate-0.8b-litert-lm](https://huggingface.co/OS-Software/plamo-3-translate-0.8b-litert-lm)
- [OS-Software/plamo-3-translate-2b-litert-lm](https://huggingface.co/OS-Software/plamo-3-translate-2b-litert-lm)

## 開発

[Bun](https://bun.sh/) を使います。

```bash
bun install
bun run dev        # 開発サーバー
bun run build      # 本番ビルド (dist/)
bun run preview    # ビルド成果物のプレビュー
bun run lint
bun run typecheck
```

- 開発サーバーは、モデルを `/models/*` から読みます。`.env.example` を `.env.local` にコピーし、`PLAMO_MODELS_DIR` に `.litertlm` を置いたフォルダを指定してください。
- 本番ビルドは、`.env.production` にある Hugging Face の URL (コミット固定) からモデルを読みます。
- `bun run verify` などの照合用スクリプトは、手元のモデルと参照データを使う開発環境専用のものです。

`main` に push すると、GitHub Actions ([deploy-pages.yml](.github/workflows/deploy-pages.yml)) が GitHub Pages に公開します。

## 技術スタック

TypeScript / Bun / Vite / React / Tailwind CSS / daisyUI / LiteRT-LM (`@litert-lm/core`)

## ライセンス

Built with PLaMo

このリポジトリのコードは [MIT License](LICENSE) です。`public/tokenizer/` の語彙は PLaMo 3 Translate のもので、MIT License の対象ではありません。

モデル (PLaMo 3 Translate) の利用には、PLaMo コミュニティライセンスが適用されます。全文は [日本語](public/licenses/LICENSE-PLaMo.ja.txt) / [English](public/licenses/LICENSE-PLaMo.en.txt) を参照してください。
