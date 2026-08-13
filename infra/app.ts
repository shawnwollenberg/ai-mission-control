#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MissionControlRegistryStack } from "./registry-stack";
import { MissionControlAppStack } from "./mission-control-stack";

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};
const stage = app.node.tryGetContext("stage") ?? "app";

if (stage === "registry") {
  new MissionControlRegistryStack(app, "MissionControlRegistry", { env });
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
