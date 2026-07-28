#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MissionControlRegistryStack } from "./registry-stack";
import { MissionControlAppStack } from "./mission-control-stack";
import { MissionControlV1EcsStack } from "./mission-control-v1-ecs-stack";

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

if (stage === "registry") {
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
