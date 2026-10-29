import prisma from "./prisma.js";

/**
 * Automatically determine audit severity level:
 * - 'critical': Deletions, bounces, cancellations, ownership transfers, security failures, archiving
 * - 'warning': Financial approvals, payments, collections, reschedules, reservations, user/role updates
 * - 'normal': Creation, regular updates, routine queries, notes, logins
 */
function resolveSeverity(action, entity, explicitSeverity) {
  if (explicitSeverity && ["normal", "warning", "critical"].includes(explicitSeverity)) {
    return explicitSeverity;
  }

  const act = String(action || "").toUpperCase();
  const ent = String(entity || "").toUpperCase();

  if (
    act.includes("DELETE") ||
    act.includes("BOUNCE") ||
    act.includes("CANCEL") ||
    act.includes("ARCHIVE") ||
    act.includes("TRANSFER") ||
    act.includes("FAILED_LOGIN") ||
    act.includes("REJECT")
  ) {
    return "critical";
  }

  if (
    act.includes("APPROVE") ||
    act.includes("PAY") ||
    act.includes("COLLECT") ||
    act.includes("RESCHEDULE") ||
    act.includes("REPLACE") ||
    act.includes("RESERVATION") ||
    act.includes("ROLE") ||
    act.includes("PRICE") ||
    act.includes("TARGET") ||
    act.includes("INVOICE") ||
    ent.includes("FINANCE") ||
    ent.includes("TREASURY")
  ) {
    return "warning";
  }

  return "normal";
}

/**
 * Reusable Audit Logging Engine
 * Records user actions across the ERP system for security, compliance, and governance.
 * Shielded to guarantee that auditing operations never crash caller workflows.
 */
export async function createAuditLog({
  request = null,
  clientAddress = null,
  userId = null,
  userName = null,
  userRole = null,
  action, // CREATE, UPDATE, DELETE, APPROVE, REJECT, TRANSFER, BOUNCE, RESCHEDULE, LOGIN, etc.
  entity, // Project, Unit, Reservation, BankCheque, Invoice, Treasury, User, Account, JournalEntry, etc.
  entityId = null,
  details = null,
  oldValues = null,
  newValues = null,
  severity = null, // "normal" | "warning" | "critical"
  ipAddress = null
}) {
  try {
    let resolvedIp = ipAddress;
    if (clientAddress && !resolvedIp) {
      resolvedIp = clientAddress;
    }
    if (request && !resolvedIp) {
      resolvedIp =
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "127.0.0.1";
    }

    const finalSeverity = resolveSeverity(action, entity, severity);

    // Ensure serializable JSON for diffs
    let safeOldValues = undefined;
    let safeNewValues = undefined;

    if (oldValues !== null && oldValues !== undefined) {
      try {
        safeOldValues = typeof oldValues === "object" ? JSON.parse(JSON.stringify(oldValues)) : { value: oldValues };
      } catch {
        safeOldValues = { raw: String(oldValues) };
      }
    }

    if (newValues !== null && newValues !== undefined) {
      try {
        safeNewValues = typeof newValues === "object" ? JSON.parse(JSON.stringify(newValues)) : { value: newValues };
      } catch {
        safeNewValues = { raw: String(newValues) };
      }
    }

    const log = await prisma.auditLog.create({
      data: {
        userId: userId || null,
        userName: userName || "نظام ERP",
        userRole: userRole || "admin",
        action: action ? String(action).toUpperCase() : "GENERAL",
        entity: entity ? String(entity) : "System",
        entityId: entityId ? String(entityId) : null,
        details: details || `تم تنفيذ عملية ${action} على ${entity}`,
        oldValues: safeOldValues,
        newValues: safeNewValues,
        severity: finalSeverity,
        ipAddress: resolvedIp || "127.0.0.1"
      }
    });

    return log;
  } catch (error) {
    console.error("Audit Engine Error (shielded):", error);
    return null;
  }
}

export const logAudit = createAuditLog;
