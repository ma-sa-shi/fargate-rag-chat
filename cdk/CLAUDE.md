# CDK infrastructure — editing constraints

`cdk/README.md` describes what each stack provisions (Japanese, for humans).
`.claude/skills/cdk-deploy/SKILL.md` covers the deploy procedure. This file covers only
what is easy to break while editing the TypeScript.

## `DesiredCount` is deleted from the template on purpose (`ecs-stack.ts`)

Both services call `addPropertyDeletionOverride('DesiredCount')` on their
`CfnService`. Running task count is owned by scheduled auto scaling, not by CDK.
Re-adding `desiredCount` — or dropping the override — makes every deploy reset the
services to the CDK-declared count, silently undoing a scale-up or the nightly scale to
zero. `minCapacity: 0` on `autoScaleTaskCount` is what permits that zero.

## EFS UID 1000 is coupled to the container user (`efs-stack.ts` + `src/backend/Dockerfile`)

The access point pins `posixUser` and `createAcl` to UID/GID 1000; the backend image's
`cloud` stage creates `appuser` with `--uid 1000`. Chroma writes to `/data/chromadb`
through that access point. Changing one side alone fails at ingest time, not at deploy
time, so a diff will look clean.

## The task images in the template are placeholders (`ecs-stack.ts`)

`dummyImage` is what the CDK template carries. Real images are pushed to ECR by
`deploy-backend.yml` / `deploy-frontend.yml`, which read the *live* task definition,
swap the image, and register a new revision. Pointing the CDK construct at a real tag
means the next `cdk deploy` rolls the service back to that tag.

## Single-stage: no environment parameterization

One AWS account, one region, no dev/prod split. Do not add environment context switches,
per-environment stack ids, or environment-suffixed resource names — physical names such
as `rag-app-fastapi`, `rag-app-cluster`, and `github-actions-app-deploy-role` are
referenced verbatim by the GitHub Actions workflows.
