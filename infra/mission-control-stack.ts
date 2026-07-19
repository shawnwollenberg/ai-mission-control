import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

type MissionControlAppStackProps = cdk.StackProps & { imageTag: string };

export class MissionControlAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlAppStackProps) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: "wallyweb.com" });
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });
    const repository = ecr.Repository.fromRepositoryName(this, "Repository", "mission-control");
    const artifacts = new s3.Bucket(this, "Artifacts", {
      bucketName: `mission-control-production-artifacts-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const bootstrapSecret = new secretsmanager.Secret(this, "BootstrapSecret", {
      secretName: "mission-control/production/bootstrap",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const securityGroup = new ec2.SecurityGroup(this, "WebSecurityGroup", {
      vpc,
      description: "Public HTTPS for Mission Control; administration uses SSM",
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Caddy HTTP certificate redirect");
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Caddy HTTPS");
    const role = new iam.Role(this, "InstanceRole", { assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com") });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));
    repository.grantPull(role);
    artifacts.grantReadWrite(role);
    bootstrapSecret.grantRead(role);

    const instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup,
      role,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(24, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: false,
          }),
        },
      ],
    });
    instance.instance.addPropertyOverride("MetadataOptions.HttpPutResponseHopLimit", 2);
    const elasticIp = new ec2.CfnEIP(this, "PublicIp", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "PublicIpAssociation", {
      allocationId: elasticIp.attrAllocationId,
      instanceId: instance.instanceId,
    });
    new route53.ARecord(this, "PublicSiteRecord", {
      zone,
      recordName: "missioncontrol",
      target: route53.RecordTarget.fromIpAddresses(elasticIp.ref),
    });
    new route53.ARecord(this, "ApplicationRecord", {
      zone,
      recordName: "app.missioncontrol",
      target: route53.RecordTarget.fromIpAddresses(elasticIp.ref),
    });

    const image = `${repository.repositoryUri}:${props.imageTag}`;
    instance.userData.addCommands(
      "set -euo pipefail",
      "dnf install -y docker",
      "systemctl enable --now docker",
      "mkdir -p /opt/mission-control/{postgres,caddy-data,caddy-config}",
      `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${bootstrapSecret.secretArn} --query SecretString --output text > /root/mission-control-bootstrap`,
      "chmod 600 /root/mission-control-bootstrap",
      "MASTER_SECRET=$(cat /root/mission-control-bootstrap)",
      "DB_PASSWORD=$(printf '%sdb' \"$MASTER_SECRET\" | sha256sum | cut -d' ' -f1)",
      "SESSION_SECRET=$(printf '%ssession' \"$MASTER_SECRET\" | sha256sum | cut -d' ' -f1)",
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      "docker network create mission-control || true",
      "docker rm -f mission-control-postgres mission-control-web mission-control-caddy 2>/dev/null || true",
      'docker run -d --name mission-control-postgres --restart unless-stopped --network mission-control -e POSTGRES_DB=mission_control -e POSTGRES_USER=mission_control -e POSTGRES_PASSWORD="$DB_PASSWORD" -v /opt/mission-control/postgres:/var/lib/postgresql/data postgres:16.4-bookworm',
      "until docker exec mission-control-postgres pg_isready -U mission_control -d mission_control; do sleep 2; done",
      `docker run --rm --network mission-control -e APP_ENV=production -e DATABASE_URL=\"postgresql://mission_control:$DB_PASSWORD@mission-control-postgres:5432/mission_control\" -e SECRET_PROVIDER=aws-secrets-manager -e ALLOW_PRODUCTION_MIGRATIONS=MISSION_CONTROL_PRODUCTION ${image} npm run production:migrate`,
      `OWNER_COUNT=$(docker exec mission-control-postgres psql -U mission_control -d mission_control -tAc \"SELECT count(*) FROM workspace_memberships WHERE role='owner'\")`,
      `if [ \"$OWNER_COUNT\" = \"0\" ]; then printf '%s' \"$MASTER_SECRET\" | docker run -i --rm --network mission-control -e APP_ENV=production -e DATABASE_URL=\"postgresql://mission_control:$DB_PASSWORD@mission-control-postgres:5432/mission_control\" -e SECRET_PROVIDER=aws-secrets-manager -e PUBLIC_APP_URL=https://app.missioncontrol.wallyweb.com -e SECURE_COOKIES=true -e MISSION_CONTROL_SESSION_SECRET=\"$SESSION_SECRET\" -e ARTIFACT_STORAGE_PROVIDER=s3 -e ARTIFACT_S3_BUCKET=${artifacts.bucketName} -e ARTIFACT_S3_REGION=${this.region} -e ARTIFACT_S3_ENDPOINT=https://s3.${this.region}.amazonaws.com -e ARTIFACT_S3_USE_IAM_ROLE=true -e MISSION_CONTROL_OWNER_EMAIL=admin@wallyweb.com -e MISSION_CONTROL_OWNER_NAME='WallyWeb Owner' -e PRODUCTION_CONFIRMATION=PROVISION_MISSION_CONTROL_OWNER ${image} npm run production:provision-owner; fi`,
      `docker run -d --name mission-control-web --restart unless-stopped --network mission-control -e APP_ENV=production -e NODE_ENV=production -e DATABASE_URL=\"postgresql://mission_control:$DB_PASSWORD@mission-control-postgres:5432/mission_control\" -e SECRET_PROVIDER=aws-secrets-manager -e PUBLIC_APP_URL=https://app.missioncontrol.wallyweb.com -e SECURE_COOKIES=true -e MISSION_CONTROL_SESSION_SECRET=\"$SESSION_SECRET\" -e ARTIFACT_STORAGE_PROVIDER=s3 -e ARTIFACT_S3_BUCKET=${artifacts.bucketName} -e ARTIFACT_S3_REGION=${this.region} -e ARTIFACT_S3_ENDPOINT=https://s3.${this.region}.amazonaws.com -e ARTIFACT_S3_USE_IAM_ROLE=true ${image}`,
      "cat > /opt/mission-control/Caddyfile <<'EOF'",
      "missioncontrol.wallyweb.com, app.missioncontrol.wallyweb.com {",
      "  reverse_proxy mission-control-web:3000",
      "  encode zstd gzip",
      "}",
      "EOF",
      "docker run -d --name mission-control-caddy --restart unless-stopped --network mission-control -p 80:80 -p 443:443 -v /opt/mission-control/Caddyfile:/etc/caddy/Caddyfile:ro -v /opt/mission-control/caddy-data:/data -v /opt/mission-control/caddy-config:/config caddy:2.10-alpine",
    );
    cdk.Tags.of(instance).add("Name", "mission-control-production");
    for (const target of [this, instance]) {
      cdk.Tags.of(target).add("Project", "MissionControl");
      cdk.Tags.of(target).add("Environment", "Production");
      cdk.Tags.of(target).add("ManagedBy", "CDK");
      cdk.Tags.of(target).add("Owner", "WallyWeb");
    }
    new cdk.CfnOutput(this, "PublicSiteUrl", { value: "https://missioncontrol.wallyweb.com" });
    new cdk.CfnOutput(this, "ApplicationUrl", { value: "https://app.missioncontrol.wallyweb.com" });
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "PublicIpAddress", { value: elasticIp.ref });
    new cdk.CfnOutput(this, "ArtifactBucket", { value: artifacts.bucketName });
    new cdk.CfnOutput(this, "OwnerPasswordCommand", {
      value: `aws --profile wallyweb --region ${this.region} secretsmanager get-secret-value --secret-id ${bootstrapSecret.secretName} --query SecretString --output text`,
    });
  }
}
