# ai_app CDK infrastructure

`cdk.json` は、CDK Toolkit にこのアプリの実行方法を指示するファイル。

## 環境

この CDK アプリは **single-stage** 構成である。AWS アカウント1つ、リージョン1つ、スタック一式のみ。
依存グラフは `VpcStack → {EfsStack, RdsStack, S3Stack}（並列） → EcsStack`。
`IamStack` は完全に独立しており、任意のタイミングでデプロイされる。`EcsStack` の後段では**ない**。

dev/prod の分割は無く、`npm run deploy` は常に同一環境を対象とする。
CI（`.github/workflows/deploy-infra.yml`）も同じ方法でデプロイし、`workflow_dispatch` による手動トリガーで、単一の `AWS_ACCOUNT_ID`/`AWS_REGION` を使用する。

## アーキテクチャ

`cdk/lib/` の6スタックが構築するリソース。

- **VpcStack** — 2 AZ にまたがる `10.0.0.0/24` の VPC。各 AZ に public サブネットと `PRIVATE_ISOLATED` サブネットを1つずつ持つ。ネットワークを必要とする他の全スタックがこの VPC を受け取る。
- **EcsStack** — Fargate SPOT のサービス `rag-app-fastapi`（port 8000）と `rag-app-nextjs`（port 3000）。Next.js は ECS Service Connect 経由で `http://fastapi:8000` から FastAPI にアクセスする。
  スケジュールされた Auto Scaling により平日9時〜19時（JST）のみ稼働し、時間外は0にスケールする。デプロイでスケーリング状態が巻き戻らないよう、`DesiredCount` は CloudFormation テンプレートから意図的に削除している。
  タスクのイメージは ECR から取得され、デプロイ用ワークフローによって差し替えられる。CDK テンプレートが持つのはプレースホルダのイメージのみ。
  Next.js タスク内の `cloudflared` サイドカーがアウトバウンドのトンネルを確立する為、ALB もインバウンドポートも無しでフロントエンドに到達できる。
- **EfsStack** — `/chroma` をルートとするアクセスポイント（UID/GID 1000）。FastAPI タスクの `/data` にマウントされる。Chroma は `/data/chromadb`（`PERSIST_DIRECTORY`）に永続化する。
- **RdsStack** — isolated サブネットに置く MySQL 8.4（`db.t4g.micro`）。マスター認証情報は Secrets Manager に格納する。
- **S3Stack** — アップロードされた文書の保管先。gateway VPC endpoint 経由でアクセスする為、通信は VPC の外に出ない。
- **IamStack** — GitHub OIDC プロバイダと、CI/CD が assume する2つのロール（`github-actions-cdk-deploy-role`、`github-actions-app-deploy-role`）。

実行時のシークレット（API キー、JWT シークレット、DB パスワード、トンネルトークン）は `.env` からではなく、SSM Parameter Store と Secrets Manager から ECS タスク定義に注入される。

NAT Gateway は使用しない。タスクは public サブネットでパブリック IP を付与して起動し、OpenAI/Cohere API への egress を確保する。

図は `docs/diagrams/architecture.drawio` を参照。

## コマンド

* `npm run build`   TypeScript を JavaScript にコンパイルする
* `npm run watch`   変更を監視してコンパイルする
* `npm run test`    スタブのみ。`test/cdk.test.ts` はコメントアウトされたサンプルであり、インフラ変更の安全性は何も保証しない。安全確認には `npm run diff` を使うこと（`.claude/skills/cdk-deploy/SKILL.md` を参照）
* `npm run diff`    デプロイ済みスタックとの差分を確認する
* `npm run deploy`  全スタックをデプロイする
* `npm run destroy` 全スタックを削除する
