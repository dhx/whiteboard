import { CollaborationFrontendContribution } from "@theia/collaboration/lib/browser/collaboration-frontend-contribution";
import { injectable } from "@theia/core/shared/inversify";
import type {
  FormAuthProvider,
  WebAuthProvider,
} from "open-collaboration-protocol" with { "resolution-mode": "import" };

/**
 * `@theia/collaboration` 1.75 resolves a login endpoint such as
 * `/api/login/simple` against the server URL with Theia's `URI.resolve`, which
 * yields `http://host:8100//api/login/simple`. The OCT server answers that
 * path with 404, so the browser's CORS preflight fails and every login is
 * aborted. Passing the endpoint without its leading slash resolves it to the
 * intended `/api/login/simple`.
 */
function relativeEndpoint<T extends { endpoint: string }>(provider: T): T {
  return { ...provider, endpoint: provider.endpoint.replace(/^\/+/, "") };
}

@injectable()
export class WhiteboardCollaborationContribution extends CollaborationFrontendContribution {
  protected override handleFormAuth(
    serverUrl: string,
    token: string,
    provider: FormAuthProvider,
  ) {
    return super.handleFormAuth(serverUrl, token, relativeEndpoint(provider));
  }

  protected override handleWebAuth(
    serverUrl: string,
    token: string,
    provider: WebAuthProvider,
  ) {
    return super.handleWebAuth(serverUrl, token, relativeEndpoint(provider));
  }
}
