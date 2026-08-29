import type { WorkerDispatch, WorkerResult } from "./protocol";

export interface ProviderWorker {
  execute(dispatch: WorkerDispatch): Promise<WorkerResult>;
}

export class LocalSubscriptionWorker implements ProviderWorker {
  constructor(private readonly executeLocally: (dispatch: WorkerDispatch) => Promise<WorkerResult>) {}
  execute(dispatch: WorkerDispatch) {
    return this.executeLocally(dispatch);
  }
}
