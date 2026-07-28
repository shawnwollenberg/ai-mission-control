import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  assertV1StagingBootstrapManifestDigest,
  type V1StagingBootstrapManifest,
} from "../application/v1-staging-bootstrap-manifest";
import { canonicalJson, sha256 } from "../application/v1-production-runtime-identity";

export type MissionControlV1StagingAuthorityStackProps = cdk.StackProps & {
  runId: string;
  signingEnabled: boolean;
  bootstrapManifest?: V1StagingBootstrapManifest;
  bootstrapManifestDigest?: string;
  webImageDigest?: string;
  projectBrainImageDigest?: string;
  applicationCommit?: string;
  imagePolicies?: Record<string, unknown>[];
  runtimeIdentityPolicy?: Record<string, unknown>;
};

const runtimeIdentityFields = [
  "awsAccountId",
  "region",
  "clusterArn",
  "serviceArn",
  "deploymentId",
  "taskDefinitionArn",
  "taskArn",
  "desiredCount",
  "pendingCount",
  "deploymentCount",
  "primaryRolloutState",
  "taskLastStatus",
  "taskHealthStatus",
  "targetHealth",
  "ecrRepositoryArn",
  "imageDigest",
  "containers",
  "taskRoleArn",
  "executionRoleArn",
  "configurationDigest",
  "applicationCommit",
  "buildIdentityDigest",
  "bootstrapManifestDigest",
] as const;

export const stagingSignerCode = String.raw`
const { KMSClient, SignCommand } = require("@aws-sdk/client-kms");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { ECRClient, DescribeImagesCommand } = require("@aws-sdk/client-ecr");
const { RDSClient, DescribeDBInstancesCommand } = require("@aws-sdk/client-rds");
const { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand } = require("@aws-sdk/client-ecs");
const { ElasticLoadBalancingV2Client, DescribeTargetHealthCommand } = require("@aws-sdk/client-elastic-load-balancing-v2");
const crypto = require("crypto");
const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort((left,right) => left.localeCompare(right))
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const reject = reason => { throw new Error(reason); };
exports.handler = async event => {
  if (process.env.SIGNING_ENABLED !== "true") reject("attestation_signing_disabled");
  if (!event || Object.keys(event).length !== 1 || typeof event.canonicalEnvelope !== "string")
    reject("attestation_wrapper_rejected");
  let parsed;
  try { parsed = JSON.parse(event.canonicalEnvelope); } catch { reject("attestation_canonicalization_rejected"); }
  if (canonical(parsed) !== event.canonicalEnvelope) reject("attestation_canonicalization_rejected");
  event = parsed;
  const allowed = ["accountId","bootstrapManifestDigest","evidence","expiresAt","kind","nonce","observedAt","region","runId","schemaVersion","sequence"];
  if (!event || canonical(Object.keys(event).sort()) !== canonical(allowed) ||
      event.schemaVersion !== "mission-control-v1-staging-attestation-request/1" ||
      event.runId !== process.env.RUN_ID || event.accountId !== process.env.ACCOUNT_ID ||
      event.region !== process.env.AWS_REGION ||
      event.bootstrapManifestDigest !== process.env.BOOTSTRAP_MANIFEST_DIGEST ||
      !/^[a-f0-9-]{16,80}$/.test(event.nonce) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > 4)
    reject("attestation_request_rejected");
  const observed = Date.parse(event.observedAt), expires = Date.parse(event.expiresAt), now = Date.now();
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + 60000 ||
      now - observed > 300000 || expires <= now || expires > now + 600000) reject("attestation_stale");
  const e = event.evidence;
  const prefix = "mission-control-v1-staging-" + process.env.RUN_ID;
  const allowedDigests = new Set([process.env.WEB_IMAGE_DIGEST, process.env.PROJECT_BRAIN_IMAGE_DIGEST]);
  const imagePolicyDigests = new Set(JSON.parse(process.env.IMAGE_POLICY_DIGESTS_JSON));
  const runtimePolicyDigest = process.env.RUNTIME_IDENTITY_POLICY_DIGEST;
  let accepted = false;
  if (event.kind === "image-provenance") {
    const expectedSequence = e?.imageDigest === process.env.WEB_IMAGE_DIGEST ? 1 :
      e?.imageDigest === process.env.PROJECT_BRAIN_IMAGE_DIGEST ? 2 : 0;
    if (event.sequence !== expectedSequence) reject("attestation_sequence_rejected");
    accepted = imagePolicyDigests.has(crypto.createHash("sha256").update(canonical(e)).digest("hex")) &&
      allowedDigests.has(e?.imageDigest) && e?.ociManifestDigest === e?.imageDigest &&
      e?.bootstrapManifestDigest === process.env.BOOTSTRAP_MANIFEST_DIGEST &&
      e?.imageReference === process.env.REPOSITORY_URI + "@" + e?.imageDigest &&
      e?.provenance?.sourceCommit === process.env.APPLICATION_COMMIT &&
      e?.provenance?.sourceState === "clean" && e?.provenance?.buildMode === "production";
  } else if (event.kind === "database-binding") {
    if (event.sequence !== 3) reject("attestation_sequence_rejected");
    accepted = e?.schemaVersion === "mission-control-v1-staging-database-binding/1" &&
      e.rdsArn === process.env.DATABASE_ARN && e.resourceId === process.env.DATABASE_ID &&
      e.endpoint === process.env.DATABASE_ENDPOINT && e.port === 5432 &&
      e.bootstrapManifestDigest === process.env.BOOTSTRAP_MANIFEST_DIGEST &&
      e.caIdentifier === "rds-ca-rsa2048-g1" &&
      e.runtime?.username === "mission_control_v1_staging_runtime" &&
      e.controller?.username === "mission_control_v1_staging_controller" &&
      e.runtime?.tlsMode === "verify-full" && e.controller?.tlsMode === "verify-full";
  } else if (event.kind === "runtime-evidence") {
    if (event.sequence !== 4) reject("attestation_sequence_rejected");
    const digests = Object.values(e?.containers ?? {}).map(value => value?.imageDigest);
    const exact = ["awsAccountId","region","clusterArn","serviceArn","deploymentId","taskDefinitionArn",
      "taskArn","desiredCount","pendingCount","deploymentCount","primaryRolloutState","taskLastStatus",
      "taskHealthStatus","targetHealth","ecrRepositoryArn","imageDigest","containers","taskRoleArn",
      "executionRoleArn","configurationDigest","applicationCommit","buildIdentityDigest",
      "bootstrapManifestDigest"];
    const runtimeIdentity = Object.fromEntries(exact.map(field => [field,e?.[field]]));
    accepted = runtimePolicyDigest &&
      crypto.createHash("sha256").update(canonical(runtimeIdentity)).digest("hex") === runtimePolicyDigest &&
      e?.schemaVersion === "mission-control-ecs-control-plane-evidence-v1" &&
      e.clusterArn === process.env.CLUSTER_ARN && e.serviceArn?.includes(prefix) &&
      e.ecrRepositoryArn === process.env.REPOSITORY_ARN &&
      e.bootstrapManifestDigest === process.env.BOOTSTRAP_MANIFEST_DIGEST &&
      e.desiredCount === 1 && e.runningCount === 1 && e.pendingCount === 0 &&
      e.deploymentCount === 1 && e.taskHealthStatus === "HEALTHY" &&
      e.targetHealth === "healthy" && digests.length === 4 &&
      digests.every(digest => allowedDigests.has(digest));
  }
  if (!accepted || canonical(e).includes('"ProductionAccess":"true"')) reject("attestation_policy_rejected");
  if (event.kind === "image-provenance") {
    const live = await new ECRClient({}).send(new DescribeImagesCommand({
      repositoryName: prefix, imageIds: [{imageDigest:e.imageDigest}]
    }));
    if (live.imageDetails?.length !== 1 || live.imageDetails[0].imageDigest !== e.imageDigest)
      reject("attestation_live_image_mismatch");
  } else if (event.kind === "database-binding") {
    const live = await new RDSClient({}).send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: process.env.DATABASE_ID
    }));
    const db = live.DBInstances?.[0];
    if (live.DBInstances?.length !== 1 || db.DBInstanceArn !== e.rdsArn ||
        db.Endpoint?.Address !== e.endpoint || db.Endpoint?.Port !== e.port ||
        db.DBName !== e.databaseName || db.DBInstanceStatus !== "available" ||
        db.CACertificateIdentifier !== e.caIdentifier || db.Engine !== "postgres" ||
        db.StorageEncrypted !== true || db.PubliclyAccessible !== true)
      reject("attestation_live_database_mismatch");
  } else if (event.kind === "runtime-evidence") {
    const ecs = new ECSClient({});
    const serviceName = e.serviceArn.split("/").at(-1);
    const service = (await ecs.send(new DescribeServicesCommand({
      cluster: process.env.CLUSTER_ARN, services: [serviceName]
    }))).services?.[0];
    const listed = await ecs.send(new ListTasksCommand({
      cluster: process.env.CLUSTER_ARN, serviceName
    }));
    const tasks = listed.taskArns?.length ? (await ecs.send(new DescribeTasksCommand({
      cluster: process.env.CLUSTER_ARN, tasks: listed.taskArns
    }))).tasks : [];
    const task = tasks?.[0];
    const taskDefinition = (await ecs.send(new DescribeTaskDefinitionCommand({
      taskDefinition: e.taskDefinitionArn
    }))).taskDefinition;
    const privateIp = task?.attachments?.flatMap(a => a.details ?? [])
      .find(d => d.name === "privateIPv4Address")?.value;
    const targets = (await new ElasticLoadBalancingV2Client({}).send(new DescribeTargetHealthCommand({
      TargetGroupArn: process.env.TARGET_GROUP_ARN
    }))).TargetHealthDescriptions ?? [];
    const liveContainerDigests = Object.fromEntries((task?.containers ?? []).map(container => [
      container.name, container.imageDigest
    ]));
    const expectedContainerDigests = Object.fromEntries(Object.entries(e?.containers ?? {}).map(([name,value]) => [
      name, value?.imageDigest
    ]));
    if (!service || service.serviceArn !== e.serviceArn || service.taskDefinition !== e.taskDefinitionArn ||
        service.desiredCount !== 1 || service.runningCount !== 1 || service.pendingCount !== 0 ||
        service.deployments?.length !== 1 || service.deployments[0].id !== e.deploymentId ||
        service.deployments[0].status !== "PRIMARY" || service.deployments[0].rolloutState !== "COMPLETED" ||
        listed.taskArns?.length !== 1 || task?.taskArn !== e.taskArn ||
        task?.taskDefinitionArn !== e.taskDefinitionArn || task?.lastStatus !== "RUNNING" ||
        task?.healthStatus !== "HEALTHY" || taskDefinition?.taskRoleArn !== e.taskRoleArn ||
        taskDefinition?.executionRoleArn !== e.executionRoleArn ||
        canonical(liveContainerDigests) !== canonical(expectedContainerDigests) ||
        !privateIp || targets.length !== 1 || targets[0].Target?.Id !== privateIp ||
        targets[0].TargetHealth?.State !== "healthy")
      reject("attestation_live_runtime_mismatch");
  }
  await new S3Client({}).send(new PutObjectCommand({
    Bucket: process.env.EVIDENCE_BUCKET,
    Key: "staging/v1/signing-nonces/" + process.env.RUN_ID + "/" + event.nonce,
    Body: crypto.createHash("sha256").update(canonical(event)).digest("hex"),
    IfNoneMatch: "*",
  }));
  await new S3Client({}).send(new PutObjectCommand({
    Bucket: process.env.EVIDENCE_BUCKET,
    Key: "staging/v1/signing-sequences/" + process.env.RUN_ID + "/" + event.sequence,
    Body: crypto.createHash("sha256").update(canonical(event)).digest("hex"),
    IfNoneMatch: "*",
  }));
  const request = canonical(event);
  const result = await new KMSClient({}).send(new SignCommand({
    KeyId: process.env.KEY_ARN, Message: Buffer.from(request),
    MessageType: "RAW", SigningAlgorithm: "ED25519_SHA_512",
  }));
  const requestDigest = crypto.createHash("sha256").update(request).digest("hex");
  console.log(JSON.stringify({event:"staging_attestation_signed",runId:event.runId,kind:event.kind,
    nonce:event.nonce,requestDigest}));
  return {schemaVersion:"mission-control-v1-staging-attestation-signature/1",
    signature:Buffer.from(result.Signature).toString("base64"),keyId:result.KeyId,
    signingAlgorithm:result.SigningAlgorithm,requestDigest};
};`;

export class MissionControlV1StagingAuthorityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlV1StagingAuthorityStackProps) {
    super(scope, id, props);
    if (props.signingEnabled && props.bootstrapManifest && props.bootstrapManifestDigest)
      assertV1StagingBootstrapManifestDigest(props.bootstrapManifest, props.bootstrapManifestDigest);
    if (
      !/^[a-z0-9][a-z0-9-]{7,15}$/.test(props.runId) ||
      (props.signingEnabled &&
        (!props.bootstrapManifest ||
          !props.bootstrapManifestDigest ||
          !/^[a-f0-9]{64}$/.test(props.bootstrapManifestDigest) ||
          !props.webImageDigest ||
          !/^sha256:[a-f0-9]{64}$/.test(props.webImageDigest) ||
          !props.projectBrainImageDigest ||
          !/^sha256:[a-f0-9]{64}$/.test(props.projectBrainImageDigest) ||
          props.webImageDigest === props.projectBrainImageDigest ||
          !props.applicationCommit ||
          !/^[a-f0-9]{40}$/.test(props.applicationCommit)))
    )
      throw new Error("Staging signer requires exact run, manifest, source, and distinct image identities.");
    const prefix = `mission-control-v1-staging-${props.runId}`;
    const resources = props.bootstrapManifest?.resources;
    const collectorRoles = resources?.iamRoles.filter(({ name, arn }) => name === `${prefix}-collector` && arn) ?? [];
    if (
      props.signingEnabled &&
      (props.bootstrapManifest?.runId !== props.runId ||
        props.bootstrapManifest?.accountId !== this.account ||
        props.bootstrapManifest?.region !== this.region ||
        collectorRoles.length !== 1)
    )
      throw new Error("Staging signer bootstrap identities are contradictory.");
    const imagePolicies = props.imagePolicies ?? [];
    const imagePolicyDigests = imagePolicies.map((policy) => sha256(canonicalJson(policy)));
    const runtimeIdentityPolicyDigest = props.runtimeIdentityPolicy
      ? sha256(
          canonicalJson(
            Object.fromEntries(runtimeIdentityFields.map((field) => [field, props.runtimeIdentityPolicy?.[field]])),
          ),
        )
      : "";
    const policyDigests = imagePolicies.map((policy) => policy.imageDigest).sort();
    if (
      props.signingEnabled &&
      (imagePolicies.length !== 2 ||
        JSON.stringify(policyDigests) !==
          JSON.stringify([props.projectBrainImageDigest, props.webImageDigest].sort()) ||
        imagePolicies.some(
          (policy) =>
            policy.bootstrapManifestDigest !== props.bootstrapManifestDigest ||
            (policy.provenance as { sourceCommit?: string } | undefined)?.sourceCommit !== props.applicationCommit,
        ))
    )
      throw new Error("Staging signer image policy is incomplete or contradictory.");
    const logGroup = new logs.LogGroup(this, "SignerLogs", {
      logGroupName: `/aws/lambda/mcv1-${props.runId}-signer`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const key = new kms.Key(this, "AttestationKey", {
      alias: `alias/${prefix}-deployment-attestation`,
      description: `Disposable purpose-bound V1 staging attestation ${props.runId}`,
      keySpec: kms.KeySpec.ECC_NIST_EDWARDS25519,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const signerBoundary = new iam.ManagedPolicy(this, "SignerBoundary", {
      managedPolicyName: `${prefix}-authority-signer-boundary`,
      statements: [
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [`${logGroup.logGroupArn}:*`],
        }),
        new iam.PolicyStatement({
          actions: ["kms:Sign"],
          resources: [key.keyArn],
          conditions: { StringEquals: { "kms:SigningAlgorithm": "ED25519_SHA_512" } },
        }),
        new iam.PolicyStatement({
          actions: ["s3:PutObject"],
          resources: [
            `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/staging/v1/signing-nonces/${props.runId}/*`,
            `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/staging/v1/signing-sequences/${props.runId}/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ["ecr:DescribeImages"],
          resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${prefix}`],
        }),
        new iam.PolicyStatement({
          actions: ["rds:DescribeDBInstances"],
          resources: [`arn:aws:rds:${this.region}:${this.account}:db:${prefix}-postgres`],
        }),
        new iam.PolicyStatement({
          actions: ["ecs:DescribeServices", "ecs:DescribeTasks"],
          resources: [
            `arn:aws:ecs:${this.region}:${this.account}:service/${prefix}-cluster/${prefix}-service`,
            `arn:aws:ecs:${this.region}:${this.account}:task/${prefix}-cluster/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ["ecs:ListTasks"],
          resources: ["*"],
          conditions: {
            ArnEquals: {
              "ecs:cluster": `arn:aws:ecs:${this.region}:${this.account}:cluster/${prefix}-cluster`,
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["ecs:DescribeTaskDefinition"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["elasticloadbalancing:DescribeTargetHealth"],
          resources: ["*"],
        }),
      ],
    });
    const role = new iam.Role(this, "SignerRole", {
      roleName: `${prefix}-authority-signer`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: signerBoundary,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/mcv1-${props.runId}-signer:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTaskDefinition"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["elasticloadbalancing:DescribeTargetHealth"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:DescribeImages"],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${prefix}`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rds:DescribeDBInstances"],
        resources: [`arn:aws:rds:${this.region}:${this.account}:db:${prefix}-postgres`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeServices", "ecs:DescribeTasks"],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:service/${prefix}-cluster/${prefix}-service`,
          `arn:aws:ecs:${this.region}:${this.account}:task/${prefix}-cluster/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: {
          ArnEquals: {
            "ecs:cluster": `arn:aws:ecs:${this.region}:${this.account}:cluster/${prefix}-cluster`,
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Sign"],
        resources: [key.keyArn],
        conditions: { StringEquals: { "kms:SigningAlgorithm": "ED25519_SHA_512" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [
          `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/staging/v1/signing-nonces/${props.runId}/*`,
          `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/staging/v1/signing-sequences/${props.runId}/*`,
        ],
      }),
    );
    const signer = new lambda.Function(this, "Signer", {
      functionName: `mcv1-${props.runId}-signer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(stagingSignerCode),
      role,
      timeout: cdk.Duration.seconds(15),
      logGroup,
      environment: {
        SIGNING_ENABLED: String(props.signingEnabled),
        RUN_ID: props.runId,
        ACCOUNT_ID: this.account,
        BOOTSTRAP_MANIFEST_DIGEST: props.bootstrapManifestDigest ?? "disabled",
        WEB_IMAGE_DIGEST: props.webImageDigest ?? "disabled",
        PROJECT_BRAIN_IMAGE_DIGEST: props.projectBrainImageDigest ?? "disabled",
        APPLICATION_COMMIT: props.applicationCommit ?? "disabled",
        IMAGE_POLICY_DIGESTS_JSON: JSON.stringify(imagePolicyDigests),
        RUNTIME_IDENTITY_POLICY_DIGEST: runtimeIdentityPolicyDigest,
        KEY_ARN: key.keyArn,
        EVIDENCE_BUCKET: `mc-v1-stage-${props.runId}-${this.account}`,
        REPOSITORY_URI: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${prefix}`,
        REPOSITORY_ARN: `arn:aws:ecr:${this.region}:${this.account}:repository/${prefix}`,
        DATABASE_ARN: resources?.database.arn ?? "disabled",
        DATABASE_ID: resources?.database.id ?? "disabled",
        DATABASE_ENDPOINT: resources?.database.endpoint ?? "disabled",
        CLUSTER_ARN: resources?.ecsCluster.arn ?? "disabled",
        TARGET_GROUP_ARN: resources?.targetGroup.arn ?? "disabled",
      },
    });
    if (props.signingEnabled)
      signer.addPermission("ExactCollectorInvoke", {
        principal: new iam.ArnPrincipal(collectorRoles[0].arn!),
        action: "lambda:InvokeFunction",
      });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenySigningOutsideExactAuthoritySigner",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: {
          ArnNotEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${this.account}:role/${prefix}-authority-signer`,
          },
        },
      }),
    );
    for (const [key, value] of Object.entries({
      Environment: "staging",
      Project: "mission-control",
      Purpose: "v1-external-acceptance",
      Disposable: "true",
      ProductionAccess: "false",
      StagingRunId: props.runId,
    }))
      cdk.Tags.of(this).add(key, value);
    new cdk.CfnOutput(this, "SignerFunctionArn", { value: signer.functionArn });
    new cdk.CfnOutput(this, "SignerRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "AttestationKeyArn", { value: key.keyArn });
    new cdk.CfnOutput(this, "AuthorityContractVersion", {
      value: "mission-control-v1-staging-attestation-authority/1",
    });
  }
}
