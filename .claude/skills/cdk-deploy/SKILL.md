---
name: cdk-deploy
description: Safely diff and deploy ai_app AWS infrastructure via CDK (VpcStack -> EfsStack/RdsStack/S3Stack -> EcsStack, with IamStack independent). Use before running npm run diff, deploy, or destroy in cdk/
---

# CDK deployment rules

## Critical rules

Always:

- Treat every deployment as production.
- Run `npm run diff` before every deployment.
- Show the diff to the user.
- Wait for explicit confirmation after the diff before running `npm run deploy` or `npm run destroy`.

Never:

- Treat CDK operations as a sandbox.
- Assume previous approval covers future deployments.
- Deploy dependent stacks out of order.
- Use GitHub Actions for the initial deployment of a new AWS account.

---

## Single-stage environment

There is no dev/staging environment. Every `npm run deploy` targets the same real
infrastructure, so treat every change as production-impacting.

---

## Stack dependencies

`cdk/README.md` has the dependency graph. What it means for deploying:

`VpcStack` first, then `EfsStack`/`RdsStack`/`S3Stack` in any order, then `EcsStack`.
`IamStack` is independent — `cdk deploy --all` may place it anywhere in the graph, so
never assume it deploys after `EcsStack`.
Unless you've confirmed there is no dependency impact, deploy using `cdk deploy --all`
rather than selecting stacks manually.

Those are the TypeScript class names. The ids CDK actually accepts on the command line are
`RagVpcStack`, `RagEfsStack`, `RagRdsStack`, `RagS3Stack`, `RagEcsStack` and `IamStack` —
note that `IamStack` alone has no `Rag` prefix. Naming a stack without the prefix fails
with "no stacks match".

---

## Always diff before deploy

Before every deployment:

1. Run `npm run diff`.
2. Show the diff.
3. Wait for explicit user approval.
4. Only then run `npm run deploy`.

The diff is the primary safety check because this project has no effective CDK test suite.

Infrastructure changes can affect:

- RDS
- EFS-backed Chroma persistence
- Cloudflare Tunnel connectivity
- ECS/Fargate SPOT services

---

## CDK tests

Do not rely on `npm test` when evaluating infrastructure changes — `cdk/test/` is a
commented-out example. Passing tests are **not** evidence that a change is safe.
Always use the CDK diff as the safety signal.

---

## EFS / Chroma persistence

If changes affect `EcsStack` or `EfsStack`:

- Verify the container still runs as UID 1000 and the access point configuration is
  unchanged — see the UID coupling section in `cdk/CLAUDE.md`.
- Warn the user if either changes. The failure is silent at deploy time and only
  surfaces when a document is ingested.

---

## Destroy workflow

After `npm run destroy`:

1. Run `cdk/scripts/check-resources.sh`.
2. Confirm physical-name resources were actually removed.
3. Only use `cdk/scripts/delete-resources.sh` if leftover resources prevent rebuilding the environment.

`delete-resources.sh` is a recovery utility, not part of normal deployment.

Destroying `EcsStack` resets the ECS desired-count state.

The ECS services' running state is managed by scheduled Auto Scaling, not by `cdk deploy`.

After recreating `EcsStack`, the application remains stopped until either:

- the scheduled scale-up runs, or
- `aws ecs update-service --desired-count 1` is executed manually.

Warn the user before destroying `EcsStack`.

---

## Initial deployment

GitHub Actions cannot perform the first deployment of a new AWS account because the deployment IAM roles are created by `IamStack`.

Bootstrap a new environment locally:

```bash
cd cdk
npm ci
npm run bootstrap
npm run deploy
```

`npm ci` comes first: the CDK CLI is a devDependency, so `npm run bootstrap` has nothing to
run on a fresh clone.

`npm run deploy` is `cdk deploy --all` with no `--require-approval never`, so any IAM or
security-group change stops at an interactive confirmation prompt. That prompt cannot be
answered from a non-interactive session — hand the command to the user rather than letting
it hang. `deploy-infra.yml` passes `--require-approval never`, which is why CI does not
hit this.

After the initial bootstrap completes, use GitHub Actions for routine deployments.

---

## Routine deployment

Routine deployments use GitHub Actions.

- Infrastructure updates use `deploy-infra.yml`.
- Backend updates use `deploy-backend.yml`.
- Frontend updates use `deploy-frontend.yml`.
- `cleanup-ecs.yml` manually scales both ECS services to desired-count 0 (cost-saving stop; the scheduled Auto Scaling still applies).

All deploy workflows are `workflow_dispatch` (manual trigger) only.

Use local `npm run deploy` and `npm run destroy` only for:

- initial bootstrap
- infrastructure maintenance
- recovery
- rebuilding the environment

Do not recommend manual CDK deployment when a GitHub Actions workflow is the normal path.
