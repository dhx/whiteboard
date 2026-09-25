import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import type { FrontendApplication } from "@theia/core/lib/browser/frontend-application";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { QuickInputService } from "@theia/core/lib/browser/quick-input/quick-input-service";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import {
  type CommandContribution,
  type CommandRegistry,
} from "@theia/core/lib/common/command";
import {
  type MenuContribution,
  type MenuModelRegistry,
} from "@theia/core/lib/common/menu";
import { inject, injectable } from "@theia/core/shared/inversify";

import {
  type WhiteboardOpener,
  WhiteboardWidget,
  type WhiteboardWidgetOptions,
} from "./whiteboard-widget";

export const WhiteboardCommands = {
  OPEN_HOME: {
    id: "whiteboard.openHome",
    category: "Whiteboard",
    label: "Open Reviews",
  },
  OPEN_REVIEW: {
    id: "whiteboard.openReview",
    category: "Whiteboard",
    label: "Open Review by ID…",
  },
};

@injectable()
export class WhiteboardContribution
  implements
    CommandContribution,
    MenuContribution,
    FrontendApplicationContribution,
    WhiteboardOpener
{
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

  async openHome() {
    await this.show({});
  }

  async openReview(reviewId: string) {
    await this.show({ reviewId });
  }

  private async show(options: WhiteboardWidgetOptions) {
    const widget = await this.widgets.getOrCreateWidget<WhiteboardWidget>(
      WhiteboardWidget.FACTORY_ID,
      options,
    );

    if (!widget.isAttached)
      await this.shell.addWidget(widget, { area: "main" });

    await this.shell.activateWidget(widget.id);
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(WhiteboardCommands.OPEN_HOME, {
      execute: () => this.openHome(),
    });
    commands.registerCommand(WhiteboardCommands.OPEN_REVIEW, {
      execute: async () => {
        const reviewId = (
          await this.quickInput.input({ prompt: "Review ID" })
        )?.trim();

        if (reviewId) await this.openReview(reviewId);
      },
    });
  }

  registerMenus(menus: MenuModelRegistry) {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: WhiteboardCommands.OPEN_HOME.id,
      label: "Whiteboard",
    });
  }

  async onDidInitializeLayout(_app: FrontendApplication) {
    await this.openHome();
  }
}
