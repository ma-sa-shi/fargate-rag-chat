import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class IamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub Actions用のOIDCプロバイダは、AWSアカウントに同一URLのものを
    // 1つしか作成できない。このアカウントでは別アプリのスタックが既に作成・
    // 管理しているため、ここでは新規作成せずARNで参照する。
    // このアカウントで唯一のプロバイダになった場合は、
    // new iam.OpenIdConnectProvider による作成へ戻してよい。
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubProvider',
      `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`
    );

    const githubActionsPrincipal = new iam.WebIdentityPrincipal(
      provider.openIdConnectProviderArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          // 自分のGitHubアカウントの特定のリポジトリのみに制限
          'token.actions.githubusercontent.com:sub': 'repo:ma-sa-shi/fargate-rag-chat:*',
        },
      }
    );

    // アプリケーションのデプロイ用ロール
    // ECRへのイメージpush、ECSの更新、PassRole権限を付与するロール
    const appDeployRole = new iam.Role(this, 'GitHubActionsAppDeployRole', {
      assumedBy: githubActionsPrincipal,
      roleName: 'github-actions-app-deploy-role',
      description:
        'Role used by app-deploy.yml to push images to ECR and update the ECS service',
    });

    appDeployRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'AmazonEC2ContainerRegistryPowerUser'
      )
    );

    appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
          'ecs:UpdateService',
          'ecs:DescribeServices',
        ],
        // ECSのdescribe/register系APIはリソースレベル権限をサポートしないため*を許可
        resources: ['*'],
      })
    );

    // RegisterTaskDefinitionがtaskRole/executionRoleをECSに渡せるようにする
    appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/*`],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      })
    );

    // インフラのデプロイ用ロール
    // cdk deployの実体はCDKブートストラップが作成するcdk-*ロールへのAssumeRoleで動くため、
    // ロールにはAssumeRole権限のみを付与
    const cdkDeployRole = new iam.Role(this, 'GitHubActionsCdkDeployRole', {
      assumedBy: githubActionsPrincipal,
      roleName: 'github-actions-cdk-deploy-role',
      description: 'Role used by infra-deploy.yml to run cdk deploy',
    });

    cdkDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
      })
    );
  }
}
