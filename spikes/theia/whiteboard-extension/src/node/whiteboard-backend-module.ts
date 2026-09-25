import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { ContainerModule } from "@theia/core/shared/inversify";

import { WhiteboardBackendContribution } from "./whiteboard-backend-contribution";

export default new ContainerModule((bind) => {
  bind(WhiteboardBackendContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(WhiteboardBackendContribution);
});
