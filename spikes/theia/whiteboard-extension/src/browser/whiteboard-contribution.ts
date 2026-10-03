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
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { agentTokenNameSchema } from "../common/agent-token-types";
import {
  CreatedAgentTokenDialog,
  ManageAgentTokensDialog,
} from "./agent-token-dialogs";
import { AgentTokensClient } from "./agent-tokens-client";
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
  CREATE_AGENT_TOKEN: {
    id: "whiteboard.createAgentToken",
    category: "Whiteboard",
    label: "Create Agent Token…",
  },
  MANAGE_AGENT_TOKENS: {
    id: "whiteboard.manageAgentTokens",
    category: "Whiteboard",
    label: "Manage Agent Tokens",
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
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(AgentTokensClient) protected readonly agentTokens!: AgentTokensClient;

  /** Asks for a name and access, creates the token and shows it once. */
  async createAgentToken() {
    const name = (
      await this.quickInput.input({
        title: "Create Agent Token",
        prompt: "Name the agent or machine that will use the token.",
        placeHolder: "e.g. laptop claude code",
        validateInput: async (value) => {
          const parsed = agentTokenNameSchema.safeParse(value);

          return parsed.success ? undefined : parsed.error.issues[0]?.message;
        },
      })
    )?.trim();

    if (!name) return;

    const access = await this.quickInput.pick(
      [
        {
          label: "Read and write",
          description: "author and edit reviews",
          scope: "write" as const,
        },
        {
          label: "Read only",
          description: "list and read reviews",
          scope: "read" as const,
        },
      ],
      { title: `Access for "${name}"` },
    );

    if (!access) return;

    try {
      const created = await this.agentTokens.create(name, access.scope);

      await new CreatedAgentTokenDialog(
        created,
        this.agentTokens.claudeCommand(created.token),
      ).open();
    } catch (error) {
      void this.messages.error(
        `Could not create the agent token: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
    commands.registerCommand(WhiteboardCommands.CREATE_AGENT_TOKEN, {
      execute: () => this.createAgentToken(),
    });
    commands.registerCommand(WhiteboardCommands.MANAGE_AGENT_TOKENS, {
      execute: () => new ManageAgentTokensDialog(this.agentTokens).open(),
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
