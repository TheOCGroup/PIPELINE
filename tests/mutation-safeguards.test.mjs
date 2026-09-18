import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("Safeguards: HTTP method rejection on known API resources", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  // POST /api/v1/opportunities is a legitimate write (manual opportunity
  // creation), so it is excluded from the blanket 405 list below and covered
  // separately. The read resources still reject every write method.
  const methods = ["POST", "PUT", "PATCH", "DELETE"];
  const endpoints = [
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

  // Manual opportunity creation: PUT/PATCH/DELETE are still rejected on the
  // collection and on the write sub-resources; POST with an empty body must
  // fail fast with a bounded 400, never hang.
  for (const endpoint of ["/api/v1/opportunities", "/api/v1/opportunities/FX-OPP-0001", "/api/v1/opportunities/FX-OPP-0001/stage", "/api/v1/opportunities/FX-OPP-0001/contacts"]) {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${baseUrl}${endpoint}`, { method });
      assert.equal(res.status, 405, `${method} on ${endpoint} should be 405`);
    }
  }
  const empty = await fetch(`${baseUrl}/api/v1/opportunities`, { method: "POST" });
  assert.equal(empty.status, 400, "POST /api/v1/opportunities with an empty body must be a bounded 400");
  assert.equal((await empty.json()).error, "missing_address");
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
