# Storyboard Jam / CONTE LIVE

音楽に合わせてカットを切り替えながら、複数人で絵コンテを作るWebアプリです。

## 主な機能

- キャンバスへの描画、消しゴム、色・線幅変更、Undo / Redo
- カット追加・複製・削除、尺と演出メモの編集
- 音源のローカル読み込みとタイムライン再生
- 再生位置に合わせたカットの自動切り替え
- WebRTCによるP2P共同編集（ホスト権威モデル）
- 連番PNG + After Effects用JSXスクリプトの書き出し
- 音声付きMP4（H.264 + AAC）の書き出し

音源ファイルと再生位置は参加者それぞれの端末に閉じています。絵、カット、尺、メモだけが同期されます。

## 同期のしくみ

ホスト（最初にルームを開いた人）のブラウザが絵コンテの原本を持ちます。

- ゲストの編集はホストへ「操作」として送られ、ホストが適用してから全員へ配ります
- 保存されるのはホストの端末（localStorage）だけです
- **ホストがタブを閉じるとルームは終了し、全員が切断されます**
- サーバーはWebRTCのシグナリング（Durable Object）だけを担当し、絵コンテの中身は一切保持しません

作業内容を残したい場合は、終了前に書き出してください。

STUNのみを使うため、対称NATなど直接接続できない回線では接続に失敗することがあります。その場合はTURNサーバーの追加が必要です。

## 書き出し

画面右上の2つのボタンから行います。

**連番＋AE** … 以下をまとめたZIPをダウンロードします。

- `cut_0001.png` … 1カット1枚の1920×1080 PNG
- `<プロジェクト名>.jsx` … After Effects用スクリプト
- `cut_sheet.txt` / `timing.json` … カット表とタイミングデータ

After Effectsで [ファイル > スクリプト > スクリプトファイルを実行] からJSXを選び、連番の1枚目を指定すると、コンポ・タイムリマップのキーフレーム（HOLD補間）・カット名のマーカーまで自動生成されます。連番は「1枚＝1フレーム」として読み込まれ、Nカット目はソース時間 N/fps に対応します。音源は続けて表示されるダイアログで任意に指定できます。

**MP4** … タイムライン全体を音声付きMP4（H.264 + AAC）で書き出します。読み込み済みの音源がそのまま乗ります。WebCodecsを使うためChrome系ブラウザが必要です。AACに対応しない環境では音声がOpusになり、その場合After Effectsでは読み込めません（トーストで通知されます）。

## ルーム

URLの `?room=` がルームIDです。パラメータなしで開くとランダムなIDが発行され、URLに追記されます。「招待する」でURLをコピーして共有してください。IDを知っている人だけが参加できます。

## 必要なもの

- Node.js 22.13以上
- GitHubアカウント
- Cloudflare無料アカウント

## ローカル起動

```bash
npm install
```

```bash
npm run dev
```

表示された `http://localhost:3000` をブラウザで開きます。

## Cloudflareの初期設定

ログインするだけです。データベースの作成は不要になりました。

```bash
npx wrangler login
```

## 公開

```bash
npm run deploy
```

初回のデプロイでDurable Objectのマイグレーション（`SignalRoom`）が適用されます。成功すると `https://storyboard-jam.<アカウント名>.workers.dev` 形式のURLが表示されます。

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

同期はP2Pで行われるため、Workerへのアクセスは接続確立時のシグナリングだけです。無料枠の消費は非常に小さく、数人規模の共同制作であれば問題になりません。
