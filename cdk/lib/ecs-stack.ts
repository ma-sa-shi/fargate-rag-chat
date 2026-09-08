import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { TimeZone } from 'aws-cdk-lib';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  fileSystem: efs.IFileSystem;
  chromaAccessPoint: efs.IAccessPoint;
  dbInstance: rds.DatabaseInstance;
  dbSecurityGroup: ec2.SecurityGroup;
  mysqlRootPassword: secretsmanager.ISecret;
  bucket: s3.IBucket;
}

export class EcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const appName = 'rag-app';
    const dbName = 'db';

    // ダミーイメージを使う。実イメージはGitHub ActionsでECRにpushされる
    const dummyImage = ecs.ContainerImage.fromRegistry(
      'public.ecr.aws/nginx/nginx:1.27-alpine'
    );

    const backendRepo = new ecr.Repository(this, 'BackendRepo', {
      repositoryName: `${appName}-backend`,
      // 本番運用フェーズに入ったらRETAINに戻すこと
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // pushされていないイメージを30日で自動削除
      lifecycleRules: [
        {
          maxImageAge: cdk.Duration.days(30),
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });

    const frontendRepo = new ecr.Repository(this, 'FrontendRepo', {
      repositoryName: `${appName}-frontend`,
      // 本番運用フェーズに入ったらRETAINに戻すこと
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          maxImageAge: cdk.Duration.days(30),
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });

    // SSM
    const mysqlRootPassword = ecs.Secret.fromSecretsManager(
      props.mysqlRootPassword,
      'password'
    );

    const mysqlPasswordSecret = ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'MysqlPasswordParam',
        { parameterName: `/${appName}/database/password` }
      )
    );

    const openaiApiKeySecret = ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'OpenaiApiKeyParam',
        { parameterName: `/${appName}/api/openai_key` }
      )
    );

    const cohereApiKeySecret = ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'CohereApiKeyParam',
        { parameterName: `/${appName}/api/cohere_key` }
      )
    );

    const jwtSecret = ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'JwtSecretParam',
        { parameterName: `/${appName}/jwt_secret` }
      )
    );

    const cfTunnelTokenSecret = ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'CfTunnelTokenParam',
        { parameterName: `/${appName}/cloudflare/tunnel_token` }
      )
    );

    // クラスター定義
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${appName}-cluster`,
    });

    cluster.addDefaultCloudMapNamespace({
      name: `${appName}.business-efficiency.pro`,
      useForServiceConnect: true,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAMロール
    const nextjsTaskRole = new iam.Role(this, 'NextjsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Task role for Next.js frontend service',
    });
    // Next.jsにS3の読み書き権限を付与
    props.bucket.grantReadWrite(nextjsTaskRole);

    const fastapiTaskRole = new iam.Role(this, 'FastapiTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Task role for FastAPI backend service',
    });

    // FastAPIにEFSのマウント・書き込み権限を付与
    fastapiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [props.fileSystem.fileSystemArn],
      })
    );

    // SG定義
    const nextjsSg = new ec2.SecurityGroup(this, 'NextjsSg', {
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    const fastapiSg = new ec2.SecurityGroup(this, 'FastapiSg', {
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    fastapiSg.connections.allowFrom(nextjsSg, ec2.Port.tcp(8000));

    // 循環しないようにするためecs-stackで定義
    new ec2.CfnSecurityGroupIngress(this, 'RdsAllowFastapiIngress', {
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      groupId: props.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: fastapiSg.securityGroupId,
    });

    new ec2.CfnSecurityGroupIngress(this, 'RdsAllowNextjsIngress', {
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      groupId: props.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: nextjsSg.securityGroupId,
    });

    // FastAPIタスク定義
    const fastapiTaskDef = new ecs.FargateTaskDefinition(
      this,
      'FastapiTaskDef',
      {
        family: `${appName}-fastapi`,
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole: fastapiTaskRole,
      }
    );

    // テンプレートのイメージはpublic.ecr.awsのプレースホルダであり、CDKはECRの
    // 権限を推論できない。実イメージはデプロイ用ワークフローがプライベートECRへ
    // 差し替えるため、実行ロールにpull権限を明示的に与える。
    // これが無いとタスク起動時にecr:GetAuthorizationTokenで失敗する。
    backendRepo.grantPull(fastapiTaskDef.obtainExecutionRole());

    fastapiTaskDef.addVolume({
      name: 'chroma-volume',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.chromaAccessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    const fastapiContainer = fastapiTaskDef.addContainer('fastapi', {
      image: dummyImage,
      essential: true,
      environment: {
        ENV: 'prod',
        PYTHONUNBUFFERED: '1',
        MYSQL_HOST: props.dbInstance.dbInstanceEndpointAddress,
        MYSQL_PORT: props.dbInstance.dbInstanceEndpointPort,
        MYSQL_DATABASE: dbName,
        MYSQL_USER: 'user',
        PERSIST_DIRECTORY: '/data/chromadb',
        S3_BUCKET_NAME: props.bucket.bucketName,
      },
      secrets: {
        MYSQL_PASSWORD: mysqlPasswordSecret,
        MYSQL_ROOT_PASSWORD: mysqlRootPassword,
        OPENAI_API_KEY: openaiApiKeySecret,
        COHERE_API_KEY: cohereApiKeySecret,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fastapi', logGroup }),
    });

    fastapiContainer.addPortMappings({
      name: 'fastapi-port',
      containerPort: 8000,
    });

    fastapiContainer.addMountPoints({
      containerPath: '/data',
      sourceVolume: 'chroma-volume',
      readOnly: false,
    });

    const fastapiService = new ecs.FargateService(this, 'FastapiService', {
      cluster,
      taskDefinition: fastapiTaskDef,
      serviceName: `${appName}-fastapi`,
      // desiredCountは指定しない。指定するとcdk deployのたびにCloudFormationが
      // テンプレート上の値へ強制的に戻してしまい、スケジュールされたAutoScalingの結果を巻き戻してしまう
      securityGroups: [fastapiSg],
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1 },
      ],
      // FastAPIのURLはhttp://fastapi:8000
      serviceConnectConfiguration: {
        services: [
          { portMappingName: 'fastapi-port', dnsName: 'fastapi', port: 8000 },
        ],
      },
    });
    // テンプレートからもDesiredCountプロパティを削除し、
    // CloudFormationがこのプロパティを一切管理しないようにする（AutoScalingに完全委任）
    (
      fastapiService.node.defaultChild as ecs.CfnService
    ).addPropertyDeletionOverride('DesiredCount');

    // Next.jsタスク定義
    const nextjsTaskDef = new ecs.FargateTaskDefinition(this, 'NextjsTaskDef', {
      family: `${appName}-nextjs`,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: nextjsTaskRole,
    });

    // FastapiTaskDefと同じ理由でpull権限を与える
    frontendRepo.grantPull(nextjsTaskDef.obtainExecutionRole());

    const nextjsContainer = nextjsTaskDef.addContainer('nextjs', {
      image: dummyImage,
      essential: true,
      environment: {
        APP_ENV: 'cloud',
        FASTAPI_URL: 'http://fastapi:8000/api',
        MYSQL_HOST: props.dbInstance.dbInstanceEndpointAddress,
        MYSQL_PORT: props.dbInstance.dbInstanceEndpointPort,
        MYSQL_DATABASE: dbName,
        MYSQL_USER: 'user',
        S3_BUCKET_NAME: props.bucket.bucketName,
      },
      secrets: {
        MYSQL_PASSWORD: mysqlPasswordSecret,
        JWT_SECRET: jwtSecret,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'nextjs', logGroup }),
    });

    nextjsContainer.addPortMappings({
      name: 'nextjs-port',
      containerPort: 3000,
    });

    nextjsTaskDef.addContainer('cloudflare-tunnel', {
      image: ecs.ContainerImage.fromRegistry(
        'cloudflare/cloudflared:1871-81a53555aa82'
      ),
      essential: true,
      command: ['tunnel', '--no-autoupdate', 'run'],
      secrets: {
        TUNNEL_TOKEN: cfTunnelTokenSecret,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'cf-tunnel', logGroup }),
    });

    const nextjsService = new ecs.FargateService(this, 'NextjsService', {
      cluster,
      taskDefinition: nextjsTaskDef,
      serviceName: `${appName}-nextjs`,
      // desiredCountは指定しない
      securityGroups: [nextjsSg],
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1 },
      ],
      // Service Connect有効化のため
      serviceConnectConfiguration: {},
    });
    (
      nextjsService.node.defaultChild as ecs.CfnService
    ).addPropertyDeletionOverride('DesiredCount');

    nextjsService.node.addDependency(fastapiService);

    // 09:00(JTC)起動, 19:00(JTC)停止
    const startSchedule = appscaling.Schedule.cron({
      hour: '9',
      minute: '0',
      weekDay: 'MON-FRI',
    });
    const stopSchedule = appscaling.Schedule.cron({
      hour: '19',
      minute: '0',
      weekDay: 'MON-FRI',
    });

    const fastapiScaling = fastapiService.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 1,
    });
    fastapiScaling.scaleOnSchedule('FastapiScaleUp', {
      schedule: startSchedule,
      minCapacity: 1,
      maxCapacity: 1,
      timeZone: TimeZone.ASIA_TOKYO,
    });
    fastapiScaling.scaleOnSchedule('FastapiScaleDown', {
      schedule: stopSchedule,
      minCapacity: 0,
      maxCapacity: 0,
      timeZone: TimeZone.ASIA_TOKYO,
    });

    const nextjsScaling = nextjsService.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 1,
    });
    nextjsScaling.scaleOnSchedule('NextjsScaleUp', {
      schedule: startSchedule,
      minCapacity: 1,
      maxCapacity: 1,
      timeZone: TimeZone.ASIA_TOKYO,
    });
    nextjsScaling.scaleOnSchedule('NextjsScaleDown', {
      schedule: stopSchedule,
      minCapacity: 0,
      maxCapacity: 0,
      timeZone: TimeZone.ASIA_TOKYO,
    });
  }
}
