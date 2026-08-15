import { signServiceToken } from "../../auth/tokenService.js";
import { randomUUID } from "node:crypto";

export class OcgOneClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.ocgOneBaseUrl;
    this.isEnabled = config.integrationEnabled;
  }

  async generateToken(method, path) {
    const privateKey = this.config.servicePrivateKey;
    const keyId = this.config.serviceKeyId;
    const issuer = this.config.serviceIssuer;
    const audience = this.config.serviceAudience;
    const subject = "pipeline-service";
    const jti = randomUUID();

    if (!privateKey || !keyId) {
      throw new Error("client_key_not_configured");
    }

    return await signServiceToken(privateKey, {
      keyId,
      issuer,
      audience,
      subject,
      method,
      path,
      jti
    });
  }

  async fetchWithRetry(path, options = {}, attempt = 1) {
    if (!this.isEnabled) {
      throw new Error("integration_disabled");
    }

    const url = `${this.baseUrl}${path}`;
    const method = "GET";
    const token = await this.generateToken(method, path);

    const correlationId = options.correlationId || randomUUID();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 5000);

    const headers = {
      "Authorization": `Bearer ${token}`,
      "X-Correlation-ID": correlationId,
      "Content-Type": "application/json",
      ...options.headers
    };

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const isJson = response.headers.get("content-type")?.includes("application/json");
      let body = {};
      if (isJson) {
        body = await response.json();
      } else {
        body = { error: await response.text() };
      }

      if (response.status === 200) {
        // Enforce contract major version validation
        const version = body.meta?.contractVersion || body.meta?.contract_version;
        if (!version || !version.startsWith("1.")) {
          throw Object.assign(new Error("contract_version_mismatch"), { status: 400 });
        }
        return body.data;
      }

      // Handle specific HTTP error status codes
      if ([401, 403, 404, 400, 422].includes(response.status)) {
        // Do NOT retry for authentication, authorization, not found, or validation errors
        throw Object.assign(new Error(body.error || "request_failed"), { status: response.status });
      }

      // Retry for 5xx or transient errors
      if (response.status >= 500 && attempt < 2) {
        return await this.fetchWithRetry(path, options, attempt + 1);
      }

      throw Object.assign(new Error(body.error || "server_error"), { status: response.status });
    } catch (err) {
      clearTimeout(timeoutId);

      // Handle transient fetch network failures
      if ((err.name === "AbortError" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") && attempt < 2) {
        return await this.fetchWithRetry(path, options, attempt + 1);
      }
      throw err;
    }
  }

  // Property reference service
  async getProperty(id, options = {}) {
    return this.fetchWithRetry(`/api/integrations/pipeline/v1/properties/${id}`, options);
  }

  // Person reference service
  async getPerson(id, options = {}) {
    return this.fetchWithRetry(`/api/integrations/pipeline/v1/people/${id}`, options);
  }

  // Lead reference service
  async getLead(id, options = {}) {
    return this.fetchWithRetry(`/api/integrations/pipeline/v1/leads/${id}`, options);
  }

  // Health check S2S
  async checkHealth(options = {}) {
    return this.fetchWithRetry(`/api/integrations/pipeline/v1/health`, options);
  }
}
