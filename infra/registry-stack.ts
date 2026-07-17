import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";

export class MissionControlRegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: "mission-control",
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, description: "Retain the ten most recent deployment images" }],
    });

    cdk.Tags.of(this).add("Project", "MissionControl");
    cdk.Tags.of(this).add("Environment", "Production");
    cdk.Tags.of(this).add("ManagedBy", "CDK");
    cdk.Tags.of(this).add("Owner", "WallyWeb");

    new cdk.CfnOutput(this, "RepositoryUri", { value: repository.repositoryUri });
  }
}
