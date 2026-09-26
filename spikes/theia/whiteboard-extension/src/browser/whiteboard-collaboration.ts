import {
  COLLABORATION_AUTH_TOKEN,
  CollaborationFrontendContribution,
} from "@theia/collaboration/lib/browser/collaboration-frontend-contribution";
import { FrontendApplicationConfigProvider } from "@theia/core/lib/browser/frontend-application-config-provider";
import { injectable } from "@theia/core/shared/inversify";
import {
  ConnectionProvider,
  type FormAuthProvider,
  type MessageTransportProvider,
  SocketIoTransport,
  type WebAuthProvider,
} from "open-collaboration-protocol";
import { io } from "socket.io-client";

/**
 * `@theia/collaboration` 1.75 resolves a login endpoint such as
 * `/api/login/simple` against the server URL with Theia's `URI.resolve`, which
 * yields `http://host:8100//api/login/simple`. The OCT server answers that
 * path with 404, so the browser's CORS preflight fails and every login is
 * aborted. Passing the endpoint without its leading slash resolves it below
 * the server URL, including a path prefix such as `/oct`.
 */
function relativeEndpoint<T extends { endpoint: string }>(provider: T): T {
  return { ...provider, endpoint: provider.endpoint.replace(/^\/+/, "") };
}

/**
 * OCT's own transport calls `io(url)`, which always uses `/socket.io` at the
 * origin and treats the URL's path as a socket.io namespace. Behind a gateway
 * that serves Theia (which also uses `/socket.io`) and OCT on one origin, OCT
 * lives under a prefix, so its socket.io path must carry the prefix too.
 */
function prefixedSocketIoTransport(path: string): MessageTransportProvider {
  return {
    id: "socket.io",
    createTransport: (url, headers) => {
      const socket: unknown = io(new URL(url).origin, {
        path,
        extraHeaders: headers,
      });

      // SAFETY: socket.io-client ships the same Socket as CommonJS and ESM
      // builds; TypeScript sees two declarations, the bundler loads one module.
      return new SocketIoTransport(
        socket as ConstructorParameters<typeof SocketIoTransport>[0],
      );
    },
  };
}

@injectable()
export class WhiteboardCollaborationContribution extends CollaborationFrontendContribution {
  /**
   * `COLLABORATION_SERVER_URL` may be a path such as `/oct`: the collaboration
   * server on the page's own origin, as the basic-auth gateway serves it.
   * Same-origin requests carry the browser's gateway credentials; a separate
   * origin would not get them.
   */
  protected override async getCollaborationServerUrl() {
    const configured = await super.getCollaborationServerUrl();

    return new URL(configured, window.location.href).href.replace(/\/+$/, "");
  }

  protected override async createConnectionProvider() {
    const serverUrl = await this.getCollaborationServerUrl();
    const prefix = new URL(serverUrl).pathname.replace(/\/+$/, "");

    if (!prefix) return super.createConnectionProvider();

    return new ConnectionProvider({
      url: serverUrl,
      client: FrontendApplicationConfigProvider.get().applicationName,
      fetch: window.fetch.bind(window),
      authenticationHandler: (token, meta) =>
        this.handleAuth(serverUrl, token, meta),
      transports: [prefixedSocketIoTransport(`${prefix}/socket.io`)],
      userToken: localStorage.getItem(COLLABORATION_AUTH_TOKEN) ?? undefined,
    });
  }

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
