import { CollaborationFrontendContribution } from "@theia/collaboration/lib/browser/collaboration-frontend-contribution";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ResourceResolver } from "@theia/core/lib/common/resource";
import { ContainerModule } from "@theia/core/shared/inversify";

import { AgentTokensClient } from "./agent-tokens-client";
import { WhiteboardApi } from "./whiteboard-api";
import { WhiteboardBridgeFactory } from "./whiteboard-bridge";
import { WhiteboardCanvasLoader } from "./whiteboard-canvas-loader";
import { WhiteboardCollaborationContribution } from "./whiteboard-collaboration";
import { WhiteboardContribution } from "./whiteboard-contribution";
import { WhiteboardSourceResolver } from "./whiteboard-source";
import {
  WhiteboardOpener,
  WhiteboardWidget,
  WhiteboardWidgetOptions,
} from "./whiteboard-widget";

// Theia convention: lib/ code imports the stylesheet from src/.
import "../../src/browser/style/whiteboard.css";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(WhiteboardApi).toSelf().inSingletonScope();
  bind(AgentTokensClient).toSelf().inSingletonScope();
  rebind(CollaborationFrontendContribution)
    .to(WhiteboardCollaborationContribution)
    .inSingletonScope();
  bind(WhiteboardCanvasLoader).toSelf().inSingletonScope();
  bind(WhiteboardBridgeFactory).toSelf().inSingletonScope();

  bind(WhiteboardSourceResolver).toSelf().inSingletonScope();
  bind(ResourceResolver).toService(WhiteboardSourceResolver);

  bind(WhiteboardContribution).toSelf().inSingletonScope();
  bind(WhiteboardOpener).toService(WhiteboardContribution);
  bind(CommandContribution).toService(WhiteboardContribution);
  bind(MenuContribution).toService(WhiteboardContribution);
  bind(FrontendApplicationContribution).toService(WhiteboardContribution);

  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: WhiteboardWidget.FACTORY_ID,
      createWidget: (options: WhiteboardWidgetOptions) => {
        const child = container.createChild();
        child.bind(WhiteboardWidgetOptions).toConstantValue(options);
        child.bind(WhiteboardWidget).toSelf();

        return child.get(WhiteboardWidget);
      },
    }))
    .inSingletonScope();
});
