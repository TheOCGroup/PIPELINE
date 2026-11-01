/**
 * Agent governance construction — the ONE wiring of the Issue #7 substrate
 * (identity directory -> capability service -> governed work room).
 *
 * buildServices uses this for the composed app, and Piper's executeTool
 * uses it for direct callers who were not handed the shared instances, so
 * there is no second, ungoverned construction of the work room anywhere:
 * every work room in the system carries the directory + capabilities that
 * enforce delegation hierarchy, capability checks, and approval envelopes.
 * (QUINCEY F7: the previous executeTool fallback built a bare work room —
 * same substrate, but without the governance wiring.)
 *
 * The directory's capability check resolves lazily because the capability
 * service itself resolves actors through the directory. Seeding matches
 * buildServices' long-standing behavior: the canonical hierarchy is ensured
 * whenever the substrate is constructed for a tenant.
 */
import { createAgentDirectoryService } from "./agentDirectoryService.js";
import { createAgentCapabilityService } from "./agentCapabilityService.js";
import { createAgentWorkRoomService } from "./agentWorkRoomService.js";

export function buildAgentGovernance(db, tenantId) {
  let capabilities = null;
  const directory = createAgentDirectoryService(db, tenantId, {
    can: (agentId, capability) => (capabilities ? capabilities.can(agentId, capability) : false),
  });
  capabilities = createAgentCapabilityService(db, tenantId, { directory });
  directory.ensureSeeded();
  const workRoom = createAgentWorkRoomService(db, tenantId, { directory, capabilities });
  return { directory, capabilities, workRoom };
}
