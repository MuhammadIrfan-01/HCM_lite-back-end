import { AsyncLocalStorage } from "node:async_hooks";

const tenantStorage = new AsyncLocalStorage();

export function runWithTenant(companyId, callback) {
  return tenantStorage.run(companyId ? String(companyId) : null, callback);
}

export function currentTenantId() {
  return tenantStorage.getStore() || null;
}
