#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MissionControlRegistryStack } from "./registry-stack";
import { MissionControlAppStack } from "./mission-control-stack";
import { MissionControlV1EcsStack } from "./mission-control-v1-ecs-stack";
import { MissionControlV1StagingBootstrapStack } from "./mission-control-v1-staging-bootstrap-stack";
import { MissionControlV1StagingAuthorityStack } from "./mission-control-v1-staging-authority-stack";
import { MissionControlV1StagingDeploymentStack } from "./mission-control-v1-staging-deployment-stack";
import { MissionControlV1StagingRuntimeStack } from "./mission-control-v1-staging-runtime-stack";

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};
const stage = app.node.tryGetContext("stage") ?? "app";

const context = (name: string) => {
  const value = app.node.tryGetContext(name);
  if (!value) throw new Error(`Pass -c ${name}=<value>`);
  return String(value);
};

if (stage === "v1-staging-authority") {
  const signingEnabled = app.node.tryGetContext("signingEnabled") === "true";
  const bootstrapManifest = signingEnabled
    ? JSON.parse(readFileSync(resolve(context("bootstrapManifestPath")), "utf8"))
    : undefined;
  new MissionControlV1StagingAuthorityStack(app, "MissionControlV1StagingAuthority", {
    env,
    stackName: `mission-control-v1-staging-${context("runId")}-authority`,
    runId: context("runId"),
    signingEnabled,
    bootstrapManifest,
    bootstrapManifestDigest: signingEnabled ? context("bootstrapManifestDigest") : undefined,
    webImageDigest: signingEnabled ? context("webImageDigest") : undefined,
    projectBrainImageDigest: signingEnabled ? context("projectBrainImageDigest") : undefined,
    applicationCommit: signingEnabled ? context("applicationCommit") : undefined,
    imagePolicies: signingEnabled ? JSON.parse(readFileSync(resolve(context("imagePoliciesPath")), "utf8")) : undefined,
    runtimeIdentityPolicy:
      signingEnabled && app.node.tryGetContext("runtimeIdentityPolicyPath")
        ? JSON.parse(readFileSync(resolve(context("runtimeIdentityPolicyPath")), "utf8"))
        : undefined,
  });
} else if (stage === "v1-staging-deployment") {
  new MissionControlV1StagingDeploymentStack(app, "MissionControlV1StagingDeployment", {
    env,
    stackName: `mission-control-v1-staging-${context("runId")}-deployment`,
    runId: context("runId"),
    operatorRoleArn: context("operatorRoleArn"),
    signerFunctionArn: context("signerFunctionArn"),
    signerRoleArn: context("signerRoleArn"),
    attestationKeyArn: context("attestationKeyArn"),
  });
} else if (stage === "v1-staging-bootstrap") {
  new MissionControlV1StagingBootstrapStack(app, "MissionControlV1StagingBootstrap", {
    env,
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    stackName: `mission-control-v1-staging-${context("runId")}-bootstrap`,
    runId: context("runId"),
    operatorRoleArn: context("operatorRoleArn"),
    operatorIpv4Cidr: context("operatorIpv4Cidr"),
    certificateArn: context("certificateArn"),
    signerFunctionArn: context("signerFunctionArn"),
    attestationKeyArn: context("attestationKeyArn"),
  });
} else if (stage === "v1-staging-runtime") {
  const bootstrapManifest = JSON.parse(readFileSync(resolve(context("bootstrapManifestPath")), "utf8"));
  new MissionControlV1StagingRuntimeStack(app, "MissionControlV1StagingRuntime", {
    env,
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    stackName: `mission-control-v1-staging-${context("runId")}-runtime`,
    runId: context("runId"),
    bootstrapManifest,
    bootstrapManifestDigest: context("bootstrapManifestDigest"),
    webImageDigest: context("webImageDigest"),
    projectBrainImageDigest: context("projectBrainImageDigest"),
    stagingConfigurationDigest: context("stagingConfigurationDigest"),
    applicationCommit: context("applicationCommit"),
    buildIdentityDigest: context("buildIdentityDigest"),
    projectBrainBuildIdentityDigest: context("projectBrainBuildIdentityDigest"),
    stagingCertificateDerSha256: context("stagingCertificateDerSha256"),
  });
} else if (stage === "registry") {
  new MissionControlRegistryStack(app, "MissionControlRegistry", { env });
} else if (stage === "v1-ecs") {
  new MissionControlV1EcsStack(app, "MissionControlV1Ecs", {
    env,
    vpcId: context("vpcId"),
    availabilityZones: context("availabilityZones").split(","),
    publicSubnetIds: context("publicSubnetIds").split(","),
    webImageDigest: context("webImageDigest"),
    projectBrainImageDigest: context("projectBrainImageDigest"),
    databaseSecretArn: context("databaseSecretArn"),
    runtimeSecretArn: context("runtimeSecretArn"),
    artifactBucketName: context("artifactBucketName"),
    certificateArn: context("certificateArn"),
    productionConfigurationDigest: context("productionConfigurationDigest"),
    applicationCommit: context("applicationCommit"),
    buildIdentityDigest: context("buildIdentityDigest"),
  });
} else {
  const webImageDigest = app.node.tryGetContext("webImageDigest");
  const projectBrainImageDigest = app.node.tryGetContext("projectBrainImageDigest");
  if (!webImageDigest || !projectBrainImageDigest)
    throw new Error("Pass -c webImageDigest=sha256:<digest> and -c projectBrainImageDigest=sha256:<digest>");
  new MissionControlAppStack(app, "MissionControlProduction", {
    env,
    webImageDigest,
    projectBrainImageDigest,
  });
}
