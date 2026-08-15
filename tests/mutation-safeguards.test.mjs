import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("Safeguards: HTTP method rejection on known API resources", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const methods = ["POST", "PUT", "PATCH", "DELETE"];
  const endpoints = [
    "/api/v1/opportunities",
    "/api/v1/opportunities/FX-OPP-0001",
    "/api/v1/provenance",
    "/api/v1/classifications",
    "/api/v1/data-quality",
    "/api/v1/system/status"
  ];

  for (const endpoint of endpoints) {
    for (const method of methods) {
      const res = await fetch(`${baseUrl}${endpoint}`, { method });
      assert.equal(res.status, 405, `${method} on ${endpoint} should be 405`);
      assert.equal(res.headers.get("Allow"), "GET, HEAD");
      const body = await res.json();
      assert.equal(body.error, "method_not_allowed");
    }
  }
});

test("Safeguards: Unknown API path returns 404 regardless of HTTP method", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  for (const method of methods) {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`, { method });
    assert.equal(res.status, 404, `${method} on unknown API path should be 404`);
    const body = await res.json();
    assert.equal(body.error, "not_found");
  }

  // Check /api/ (non-v1) paths
  for (const method of methods) {
    const res = await fetch(`${baseUrl}/api/does-not-exist`, { method });
    assert.equal(res.status, 404, `${method} on non-v1 API path should be 404`);
  }
});

test("Safeguards: Frontend path with unsupported method returns 405 (no SPA fallback)", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const methods = ["POST", "PUT", "PATCH", "DELETE"];
  const paths = ["/", "/opportunities", "/provenance", "/classifications", "/data-quality", "/system", "/does-not-exist"];

  for (const path of paths) {
    for (const method of methods) {
      // Exclude /auth/handoff which allows POST
      if (path === "/auth/handoff" && method === "POST") continue;

      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 405, `${method} on frontend path ${path} should be 405`);
      const body = await res.json();
      assert.equal(body.error, "method_not_allowed");
    }
  }
});
