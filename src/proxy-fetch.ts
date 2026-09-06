import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export interface ProxyEnvironmentOptions {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface ProxyAwareFetch {
  fetch: typeof globalThis.fetch;
  proxyEnabled: boolean;
  close: () => Promise<void>;
}

function environmentValue(
  env: Record<string, string | undefined>,
  lowerName: string,
  upperName: string,
): string {
  return (env[lowerName]?.trim() || env[upperName]?.trim() || "");
}

export function proxyEnvironmentOptions(
  env: Record<string, string | undefined>,
): ProxyEnvironmentOptions | undefined {
  const httpProxy = environmentValue(env, "http_proxy", "HTTP_PROXY");
  const httpsProxy = environmentValue(env, "https_proxy", "HTTPS_PROXY") || httpProxy;
  if (!httpProxy && !httpsProxy) return undefined;
  return {
    httpProxy,
    httpsProxy,
    noProxy: environmentValue(env, "no_proxy", "NO_PROXY"),
  };
}

export function createProxyAwareFetch(
  env: Record<string, string | undefined>,
): ProxyAwareFetch {
  const proxyOptions = proxyEnvironmentOptions(env);
  if (!proxyOptions) {
    return {
      fetch: globalThis.fetch,
      proxyEnabled: false,
      close: async () => {},
    };
  }

  const dispatcher = new EnvHttpProxyAgent(proxyOptions);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await undiciFetch(
      input as never,
      { ...init, dispatcher } as never,
    );
    return response as unknown as Response;
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    proxyEnabled: true,
    close: async () => {
      await dispatcher.close();
    },
  };
}
