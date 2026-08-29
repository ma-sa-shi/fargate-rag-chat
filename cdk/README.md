# ai_app CDK infrastructure

ai_appのAWSインフラをTypeScriptのCDKで定義する。スタックの構成と、デプロイに使うnpm scriptsを記載する。デプロイ手順と安全確認のルールは`.claude/skills/cdk-deploy/`にある。

## 環境

このCDKアプリはsingle-stage構成である。AWSアカウント1つ、リージョン1つ、スタック一式のみ。
依存グラフは`VpcStack → {EfsStack, RdsStack, S3Stack}(並列) → EcsStack`。
一方`IamStack`は完全に独立しており、任意のタイミングでデプロイされる。したがって`EcsStack`の後段ではない。

dev/prodの分割は無く、`npm run deploy`は常に同一環境を対象とする。
またCI(`.github/workflows/deploy-infra.yml`)は`npx cdk diff --all`のあと`npx cdk deploy --all --require-approval never`を実行する。トリガーは`workflow_dispatch`による手動のみで、アカウントとリージョンはOIDCで引き受けたロールから決まる。

## デプロイ前に必要なもの

`EcsStack`はSSM Parameter StoreのSecureStringを作成せず、既存のものを参照する。そのため次の5件が事前に存在しないと、初回デプロイが失敗する。

| パラメータ名 | 用途 |
|---|---|
| `/rag-app/database/password` | アプリ用MySQLユーザーのパスワード |
| `/rag-app/api/openai_key` | OpenAI APIキー |
| `/rag-app/api/cohere_key` | Cohere APIキー |
| `/rag-app/jwt_secret` | JWT署名鍵 |
| `/rag-app/cloudflare/tunnel_token` | Cloudflare Tunnelのトークン |

ただしRDSのマスター認証情報だけは、`RdsStack`がSecrets Managerに自動生成する。

## アーキテクチャ

`cdk/lib/`の6スタックが構築するリソース。見出しはクラス名で、括弧内がCDKに渡すスタックIDである。`IamStack`だけ`Rag`接頭辞が付かない。

- **VpcStack**(`RagVpcStack`) — 2 AZにまたがる`10.0.0.0/24`のVPC。各AZにpublicサブネットと`PRIVATE_ISOLATED`サブネットを1つずつ持つ。ネットワークを必要とする他の全スタックがこのVPCを受け取る。
- **EcsStack**(`RagEcsStack`) — クラスタ`rag-app-cluster`と、Fargate SPOTのサービス`rag-app-fastapi`(port 8000)、`rag-app-nextjs`(port 3000)。Next.jsはECS Service Connect経由で`http://fastapi:8000`からFastAPIにアクセスする。ECRリポジトリ`rag-app-backend` / `rag-app-frontend`もこのスタックが作る。
  スケジュールされたAuto Scalingにより平日9時から19時(JST)のみ稼働し、時間外は0にスケールする。デプロイでスケーリング状態が巻き戻らないよう、`DesiredCount`はCloudFormationテンプレートから意図的に削除している。
  タスクのイメージはデプロイ用ワークフローが差し替えるため、CDKテンプレートが持つのはプレースホルダのイメージのみである。
  Next.jsタスク内の`cloudflared`サイドカーがアウトバウンドのトンネルを確立するため、ALBもインバウンドポートも無しでフロントエンドに到達できる。
- **EfsStack**(`RagEfsStack`) — `/chroma`をルートとするアクセスポイント(UID/GID 1000)。FastAPIタスクの`/data`にマウントされる。Chromaは`/data/chromadb`(`PERSIST_DIRECTORY`)に永続化する。
- **RdsStack**(`RagRdsStack`) — isolatedサブネットに置くMySQL 8.4(`db.t4g.micro`)。マスター認証情報はSecrets Managerに格納する。
- **S3Stack**(`RagS3Stack`) — アップロードされたドキュメントの保管先。gateway VPC endpoint経由でアクセスするため、通信はVPCの外に出ない。
- **IamStack**(`IamStack`) — GitHub OIDCプロバイダと、CI/CDがassumeする2つのロール(`github-actions-cdk-deploy-role`、`github-actions-app-deploy-role`)。

NAT Gatewayは使用しない。代わりにタスクをpublicサブネットでパブリックIPを付与して起動し、OpenAI/Cohere APIへのegressを確保する。

図はリポジトリルートの`docs/diagrams/architecture.drawio`を参照。

## コマンド

初回、および依存を更新したときは`npm ci`を先に実行する。CDK CLIはdevDependencyであり、これを省くとnpm scriptsが動かないためである。

* `npm run build`   TypeScriptをJavaScriptにコンパイルする
* `npm run watch`   変更を監視してコンパイルする
* `npm run test`    スタブのみ。`test/cdk.test.ts`はコメントアウトされたサンプルであり、インフラ変更の安全性は何も保証しない。安全確認には`npm run diff`を使うこと
* `npm run diff`    デプロイ済みスタックとの差分を確認する
* `npm run bootstrap` 新規アカウントのCDKブートストラップ。初回のみ
* `npm run deploy`  全スタックをデプロイする。`--require-approval never`を付けていないため、IAMやセキュリティグループの変更では対話的な確認を求められる
* `npm run destroy` 全スタックを削除する
