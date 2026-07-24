import { ProjectBrainClient } from "./client";
import type { ProjectBrainOperation, ProjectBrainResult } from "./types";

type Scope = {
  workspaceId: string;
  repositoryId: string;
  repositoryPath: string;
  missionId?: string;
  executionId?: string;
};

export class ProjectBrainService {
  constructor(private readonly client: ProjectBrainClient) {}

  status(scope: Scope) {
    return this.read(scope, "detect_repository");
  }
  summary(scope: Scope) {
    return this.read(scope, "get_summary");
  }
  health(scope: Scope) {
    return this.read(scope, "get_health");
  }
  diagnostics(scope: Scope) {
    return this.read(scope, "diagnostics");
  }
  approvalInbox(scope: Scope) {
    return Promise.all([this.read(scope, "list_knowledge"), this.read(scope, "get_curation")]);
  }
  previewContext<T = unknown>(scope: Scope, request: Record<string, unknown>) {
    return this.run<T>(scope, "prepare_context", { ...request, preview: true });
  }
  prepareAndBindContext(scope: Scope, request: Record<string, unknown>) {
    return this.run(scope, "prepare_context", {
      ...request,
      mission_id: scope.missionId,
      execution_id: scope.executionId,
      write: true,
    });
  }
  readContext<T = unknown>(scope: Scope, request: Record<string, unknown>) {
    return this.run<T>(scope, "read_context", request);
  }
  recordClosure(scope: Scope, request: Record<string, unknown>) {
    return this.run(scope, "record_closure", request);
  }
  proposeLearning(scope: Scope, request: Record<string, unknown>) {
    return this.run(scope, "propose_learning", request);
  }
  evaluateLearning(scope: Scope, request: Record<string, unknown>) {
    return this.run(scope, "evaluate_learning", request);
  }
  private read(scope: Scope, operation: ProjectBrainOperation) {
    return this.run(scope, operation, {});
  }
  private run<T>(scope: Scope, operation: ProjectBrainOperation, request: Record<string, unknown>): Promise<ProjectBrainResult<T>> {
    return this.client.execute<T>({ ...scope, operation, request });
  }
}
