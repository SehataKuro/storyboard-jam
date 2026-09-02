# Storyboard Jam / CONTE LIVE

音楽に合わせてカットを切り替えながら、複数人で絵コンテを作るWebアプリです。

## 主な機能

- キャンバスへの描画、消しゴム、色・線幅変更、Undo / Redo
- カット追加・複製・削除、尺と演出メモの編集
- 音源のローカル読み込みとタイムライン再生
- 再生位置に合わせたカットの自動切り替え
- Cloudflare D1によるカット・描画データの共有と自動保存

現時点では、音源ファイルは参加者それぞれの端末で読み込みます。絵、カット、尺、メモはオンライン同期されます。

## 必要なもの

- Node.js 22.13以上
- GitHubアカウント
- Cloudflare無料アカウント

## ローカル起動

```bash
npm install
npm run dev
```

表示された `http://localhost:3000` をブラウザで開きます。ローカル開発ではD1のデータも端末内に保存されます。

## Cloudflareの初期設定

まずCloudflareへログインします。

```bash
npx wrangler login
```

D1データベースを作成します。

```bash
npx wrangler d1 create storyboard-jam-db --location apac
```

コマンドの結果に表示される `database_id` を `wrangler.jsonc` の仮IDと置き換えます。

続いてテーブルを作成します。

```bash
npm run db:migrate:remote
```

## 最初の公開

```bash
npm run deploy
```

成功すると `https://storyboard-jam.<アカウント名>.workers.dev` 形式のURLが表示されます。

## GitHubから自動公開

1. このフォルダの中身をGitHubの `storyboard-jam` リポジトリへアップロードします。
2. Cloudflare管理画面で **Workers & Pages → Create application → Import a repository** を選びます。
3. GitHubを接続し、`storyboard-jam` リポジトリを選択します。
4. Production branchを `main` にします。
5. Build commandを `npm run build` にします。
6. Deploy commandを `npx wrangler deploy --config dist/server/wrangler.json` にします。
7. Save and Deployを押します。

以後、GitHubの `main` ブランチを更新すると自動公開されます。

## 無料枠を守るための目安

このアプリは小規模な共同制作向けです。無料枠では数人程度での利用を想定してください。長時間開きっぱなしにする参加者が増えた場合は、同期間隔を長くするかWebSocket方式へ変更します。

## 公開前の注意

初期状態では共有ルーム名が `main` 固定です。URLを知る人を限定して利用してください。本格運用前には、推測困難なルームIDと参加認証を追加することを推奨します。
